/**
 * Settings store for teams mode: presents the same get/set/delete/clear/store/
 * onDidAnyChange surface as {@link ServerStore} for a single (team, principal),
 * backed by two Postgres blobs:
 *   - `team_settings`   (team base, admin-gated)   — keyed by team id
 *   - `user_settings_v2` (per-principal overlay)    — keyed by principal id
 *
 * Routing per key follows {@link classify} (docs/teams-settings-merge.md):
 *   - team keys      → effective value = team base ⊕ user overlay (merge ops)
 *   - user/global    → user blob top level
 *   - user/team      → user blob `data.byTeam[teamId]`
 *   - identity       → user blob top level (secret bytes live in PgSecretStore)
 *   - deployment     → DEFAULTS (managers overlays env-derived values)
 *   - infra          → user blob top level
 *
 * Generic `set(key, value)` writes the **user overlay** (the user owns their
 * layer); admin team-base writes go through {@link setTeamBase}, gated upstream.
 * Reads are synchronous off in-memory caches hydrated once ({@link whenReady}).
 */
import { loadTeamSettings, loadUserSettings, type PgPool } from 'omni-projects-db';

import { emptyMcpConfig, emptyModelsConfig } from '@/lib/agent-config';
import { assertCleanupOwner } from '@/main/chat-runtime-journal';
import { mergeById, mergeEnvVars, mergeMcpConfig, mergeModelsConfig, mergeRecord } from '@/main/config-merge';
import { DEFAULTS } from '@/server/store';
import { applyChatCommand, type ChatCommand, type ChatCommandResult } from '@/shared/chat-commands';
import { classify } from '@/shared/settings-layers';
import type { McpConfig, ModelsConfig, StoreData } from '@/shared/types';

type ChangeCallback = (data: StoreData | undefined) => void;
type AnyRec = Record<string, unknown>;
type PendingMutation = {
  layer: 'team' | 'user';
  optimistic: boolean;
  update: (view: CompositeSettingsStore) => unknown;
};

export class CompositeSettingsStore {
  private team: AnyRec = {};
  private user: AnyRec = {};
  private changeCallbacks = new Set<ChangeCallback>();
  private teamChain: Promise<void> = Promise.resolve();
  private userChain: Promise<void> = Promise.resolve();
  private writeErrors: unknown[] = [];
  private revisions = { team: 0, user: 0 };
  private pending = new Set<PendingMutation>();
  readonly whenReady: Promise<void>;

  constructor(
    private readonly pool: PgPool,
    private readonly teamId: string,
    private readonly principalId: string,
    private readonly originId = ''
  ) {
    this.whenReady = this.load();
  }

  private async load(): Promise<void> {
    const [team, user] = await Promise.all([
      loadTeamSettings(this.pool, this.teamId),
      loadUserSettings(this.pool, this.principalId),
    ]);
    this.team = team ?? {};
    this.user = user ?? {};
    this.notify();
  }

  async reloadTeam(): Promise<void> {
    await this.teamChain;
    const revision = this.revisions.team;
    const data = (await loadTeamSettings(this.pool, this.teamId)) ?? {};
    if (revision === this.revisions.team) {
      this.install('team', data);
    }
  }

  async reloadUser(): Promise<void> {
    await this.userChain;
    const revision = this.revisions.user;
    const data = (await loadUserSettings(this.pool, this.principalId)) ?? {};
    if (revision === this.revisions.user) {
      this.install('user', data);
    }
  }

  private byTeam(): AnyRec {
    const bt = (this.user['byTeam'] as Record<string, AnyRec> | undefined) ?? {};
    return bt[this.teamId] ?? {};
  }

  /** Serialize against the database row, including the first-ever write. Never
   * persist a cached whole-document snapshot: another replica may own newer keys. */
  private async mutate<R>(
    layer: 'team' | 'user',
    update: (view: CompositeSettingsStore) => R,
    pending: PendingMutation
  ): Promise<R> {
    await this.whenReady;
    const client = await this.pool.connect();
    const table = layer === 'team' ? 'team_settings' : 'user_settings_v2';
    const column = layer === 'team' ? 'team_id' : 'principal_id';
    const id = layer === 'team' ? this.teamId : this.principalId;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config($1, $2, true), set_config('app.current_origin', $3, true)", [
        layer === 'team' ? 'app.current_tenant' : 'app.current_principal',
        id,
        this.originId,
      ]);
      // Transaction-scoped advisory lock also protects a row that does not exist yet.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${table}:${id}`]);
      const rows = await client.query(`SELECT data FROM ${table} WHERE ${column} = $1 FOR UPDATE`, [id]);
      const view = Object.create(CompositeSettingsStore.prototype) as CompositeSettingsStore;
      Object.assign(view, { teamId: this.teamId, team: this.team, user: this.user });
      view[layer] = rows.rows[0]?.data ?? {};
      const result = update(view);
      await client.query(
        `INSERT INTO ${table} (${column}, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (${column}) DO UPDATE SET data = EXCLUDED.data,
         updated_at = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')`,
        [id, JSON.stringify(view[layer])]
      );
      await client.query('COMMIT');
      this.pending.delete(pending);
      this.install(layer, view[layer]);
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private install(layer: 'team' | 'user', data: AnyRec): void {
    ++this.revisions[layer];
    this[layer] = data;
    for (const entry of this.pending) {
      if (entry.layer === layer && entry.optimistic) {
        entry.update(this);
      }
    }
    this.notify();
  }

  private enqueue<R>(
    layer: 'team' | 'user',
    update: (view: CompositeSettingsStore) => R,
    optimistic = false
  ): Promise<R> {
    const key = layer === 'team' ? 'teamChain' : 'userChain';
    ++this.revisions[layer];
    const pending = { layer, update, optimistic };
    this.pending.add(pending);
    if (optimistic) {
      update(this);
    }
    const operation = this[key].then(() => this.mutate(layer, update, pending));
    // Legacy setters are void. Observe rejection immediately, but preserve it for
    // the durability barrier instead of converting failed writes into success.
    this[key] = operation.then(
      () => undefined,
      async (error: unknown) => {
        // Async commands deliver their own rejection to the caller. Only void
        // setters need a later barrier; don't leak an already-reported command
        // failure into an unrelated future settings RPC.
        if (optimistic) {
          this.writeErrors.push(error);
        }
        this.pending.delete(pending);
        try {
          const data =
            layer === 'team'
              ? await loadTeamSettings(this.pool, this.teamId)
              : await loadUserSettings(this.pool, this.principalId);
          this.install(layer, data ?? {});
        } catch {
          /* The failed write remains visible to flush(). */
        }
      }
    );
    return operation;
  }

  async chatCommand(command: ChatCommand, context: Partial<StoreData> = {}): Promise<ChatCommandResult> {
    return this.enqueue('user', (view) => {
      const { patch, result } = applyChatCommand(
        {
          ...view.store,
          projects: context.projects ?? view.store.projects,
          availableSandboxProfiles: context.availableSandboxProfiles ?? view.store.availableSandboxProfiles,
        },
        command
      );
      for (const [key, value] of Object.entries(patch)) {
        view.writeUser(key as keyof StoreData, value as never);
      }
      return result;
    });
  }

  async acknowledgeChatCleanup(id: string): Promise<void> {
    await this.enqueue('user', (view) => {
      view.writeUser(
        'chatCleanupJobs',
        (view.get('chatCleanupJobs') ?? []).filter((job) => job.id !== id)
      );
    });
  }

  async claimChatRuntime(id: string, runtimeOwner: string): Promise<void> {
    await this.enqueue('user', (view) => {
      const tabs = view.get('codeTabs') ?? [];
      if (!tabs.some((tab) => tab.id === id)) {
        throw new Error('This chat tab has been closed');
      }
      assertCleanupOwner(tabs.find((tab) => tab.id === id)?.runtimeOwner);
      view.writeUser(
        'codeTabs',
        tabs.map((tab) => (tab.id === id ? { ...tab, runtimeOwner } : tab))
      );
    });
  }

  private notify(): void {
    const snap = this.store;
    for (const cb of this.changeCallbacks) {
      try {
        cb(snap);
      } catch (error) {
        console.error('[CompositeSettings] subscriber failed:', error);
      }
    }
  }

  /** Effective value of a `team` key (team base ⊕ user overlay). */
  private mergedTeamValue<K extends keyof StoreData>(key: K): StoreData[K] | undefined {
    const base = this.team[key as string];
    const overlay = this.byTeam()[key as string];
    switch (key) {
      case 'modelsConfig':
        return mergeModelsConfig(
          (base as ModelsConfig) ?? emptyModelsConfig(),
          (overlay as ModelsConfig) ?? emptyModelsConfig()
        ) as StoreData[K];
      case 'mcpConfig': {
        const tombstones = (this.byTeam()['mcpTombstones'] as string[] | undefined) ?? [];
        return mergeMcpConfig(
          (base as McpConfig) ?? emptyMcpConfig(),
          (overlay as McpConfig) ?? emptyMcpConfig(),
          tombstones
        ) as StoreData[K];
      }
      case 'envVars':
        return mergeEnvVars(
          (base as string) ?? '',
          (overlay as string) ?? '',
          (this.team['envLockedKeys'] as string[] | undefined) ?? []
        ) as StoreData[K];
      case 'networkConfig':
        // Deployment floor ∩ team is applied at agent launch; the snapshot shows
        // the team base (no user overlay for the security boundary).
        return (base ?? overlay ?? DEFAULTS[key]) as StoreData[K];
      case 'customApps':
        return mergeById(
          (base as Array<{ id: string }>) ?? [],
          (overlay as Array<{ id: string }>) ?? []
        ) as StoreData[K];
      default:
        // skillSources / installedBundles / enabledExtensions — record union.
        return mergeRecord(base as AnyRec, overlay as AnyRec) as StoreData[K];
    }
  }

  get<K extends keyof StoreData>(key: K, defaultValue?: StoreData[K]): StoreData[K] {
    const cls = classify(key);
    let val: unknown;
    if (cls.layer === 'team') {
      val = this.mergedTeamValue(key);
    } else if (cls.layer === 'deployment') {
      val = DEFAULTS[key];
    } else if (cls.scope === 'team') {
      val = this.byTeam()[key as string];
    } else {
      val = this.user[key as string];
    }
    if (val === undefined) {
      val = defaultValue !== undefined ? defaultValue : DEFAULTS[key];
    }
    return val as StoreData[K];
  }

  /** Write the user overlay (the user owns their layer). Team keys write the per-team overlay. */
  set<K extends keyof StoreData>(key: K, value: StoreData[K]): void;
  set(data: Partial<StoreData>): void;
  set<K extends keyof StoreData>(keyOrData: K | Partial<StoreData>, value?: StoreData[K]): void {
    const patch = structuredClone(typeof keyOrData === 'string' ? { [keyOrData]: value } : keyOrData);
    void this.enqueue(
      'user',
      (view) => {
        for (const [k, v] of Object.entries(patch)) {
          view.writeUser(k as keyof StoreData, v as never);
        }
      },
      true
    );
  }

  private writeUser<K extends keyof StoreData>(key: K, value: StoreData[K]): void {
    const cls = classify(key);
    if (cls.layer === 'deployment') {
      return;
    } // not user-writable
    if (cls.layer === 'team' || cls.scope === 'team') {
      const bt = ((this.user['byTeam'] as Record<string, AnyRec> | undefined) ?? {}) as Record<string, AnyRec>;
      const teamDoc = { ...(bt[this.teamId] ?? {}) };
      teamDoc[key as string] = value as unknown;
      this.user['byTeam'] = { ...bt, [this.teamId]: teamDoc };
    } else {
      this.user[key as string] = value as unknown;
    }
  }

  /** Admin team-base write (gated upstream). Writes the raw base value for a team key. */
  setTeamBase<K extends keyof StoreData>(key: K, value: StoreData[K]): void {
    const copy = structuredClone(value);
    void this.enqueue(
      'team',
      (view) => {
        view.team[key as string] = copy;
      },
      true
    );
  }

  /** Raw team-base value (unmerged) — for admin editing UIs. */
  getTeamBase<K extends keyof StoreData>(key: K): StoreData[K] | undefined {
    return this.team[key as string] as StoreData[K] | undefined;
  }

  delete<K extends keyof StoreData>(key: K): void {
    void this.enqueue('user', (view) => view.deleteUser(key), true);
  }

  private deleteUser<K extends keyof StoreData>(key: K): void {
    const cls = classify(key);
    if (cls.layer === 'team' || cls.scope === 'team') {
      const bt = (this.user['byTeam'] as Record<string, AnyRec> | undefined) ?? {};
      if (bt[this.teamId]) {
        delete bt[this.teamId]![key as string];
      }
    } else {
      delete this.user[key as string];
    }
  }

  clear(): void {
    void this.enqueue(
      'user',
      (view) => {
        view.user = {};
      },
      true
    );
  }

  /** Full merged StoreData snapshot for this (team, principal). Project keys are filled by ProjectManager. */
  get store(): StoreData {
    const out: AnyRec = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as Array<keyof StoreData>) {
      const v = this.get(key);
      if (v !== undefined) {
        out[key as string] = v;
      }
    }
    return out as StoreData;
  }

  set store(data: StoreData) {
    // Bulk replace routes through the per-key writer (user overlay).
    this.set(data as Partial<StoreData>);
  }

  onDidAnyChange(callback: ChangeCallback): () => void {
    this.changeCallbacks.add(callback);
    return () => {
      this.changeCallbacks.delete(callback);
    };
  }

  /** Await pending write-through (durability barrier). */
  async flush(): Promise<void> {
    await Promise.all([this.teamChain, this.userChain]);
    const errors = this.writeErrors.splice(0);
    if (errors.length) {
      throw new AggregateError(errors, 'Settings persistence failed');
    }
  }
}
