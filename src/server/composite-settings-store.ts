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
import { loadTeamSettings, loadUserSettings, type PgPool, saveTeamSettings, saveUserSettings } from 'omni-projects-db';

import { emptyMcpConfig, emptyModelsConfig } from '@/lib/agent-config';
import { mergeById, mergeEnvVars, mergeMcpConfig, mergeModelsConfig, mergeRecord } from '@/main/config-merge';
import { DEFAULTS } from '@/server/store';
import { classify } from '@/shared/settings-layers';
import type { McpConfig, ModelsConfig, StoreData } from '@/shared/types';

type ChangeCallback = (data: StoreData | undefined) => void;
type AnyRec = Record<string, unknown>;

export class CompositeSettingsStore {
  private team: AnyRec = {};
  private user: AnyRec = {};
  private changeCallbacks = new Set<ChangeCallback>();
  private teamChain: Promise<void> = Promise.resolve();
  private userChain: Promise<void> = Promise.resolve();
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
    try {
      const [team, user] = await Promise.all([
        loadTeamSettings(this.pool, this.teamId),
        loadUserSettings(this.pool, this.principalId),
      ]);
      this.team = team ?? {};
      this.user = user ?? {};
    } catch (err) {
      console.error(`[CompositeSettings] load failed (team ${this.teamId}, user ${this.principalId}):`, err);
    }
    this.notify();
  }

  async reloadTeam(): Promise<void> {
    this.team = (await loadTeamSettings(this.pool, this.teamId)) ?? {};
    this.notify();
  }

  async reloadUser(): Promise<void> {
    this.user = (await loadUserSettings(this.pool, this.principalId)) ?? {};
    this.notify();
  }

  private byTeam(): AnyRec {
    const bt = (this.user['byTeam'] as Record<string, AnyRec> | undefined) ?? {};
    return bt[this.teamId] ?? {};
  }

  private persistTeam(): void {
    const snap = { ...this.team };
    this.teamChain = this.teamChain.then(() =>
      saveTeamSettings(this.pool, this.teamId, snap, this.originId).catch((e) =>
        console.error(`[CompositeSettings] team persist failed (${this.teamId}):`, e)
      )
    );
  }

  private persistUser(): void {
    const snap = { ...this.user };
    this.userChain = this.userChain.then(() =>
      saveUserSettings(this.pool, this.principalId, snap, this.originId).catch((e) =>
        console.error(`[CompositeSettings] user persist failed (${this.principalId}):`, e)
      )
    );
  }

  private notify(): void {
    const snap = this.store;
    for (const cb of this.changeCallbacks) {
      cb(snap);
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
    if (typeof keyOrData === 'string') {
      this.writeUser(keyOrData, value as StoreData[K]);
    } else {
      for (const [k, v] of Object.entries(keyOrData)) {
        this.writeUser(k as keyof StoreData, v as never);
      }
    }
    this.persistUser();
    this.notify();
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
    this.team[key as string] = value as unknown;
    this.persistTeam();
    this.notify();
  }

  /** Raw team-base value (unmerged) — for admin editing UIs. */
  getTeamBase<K extends keyof StoreData>(key: K): StoreData[K] | undefined {
    return this.team[key as string] as StoreData[K] | undefined;
  }

  delete<K extends keyof StoreData>(key: K): void {
    const cls = classify(key);
    if (cls.layer === 'team' || cls.scope === 'team') {
      const bt = (this.user['byTeam'] as Record<string, AnyRec> | undefined) ?? {};
      if (bt[this.teamId]) {
        delete bt[this.teamId]![key as string];
      }
    } else {
      delete this.user[key as string];
    }
    this.persistUser();
    this.notify();
  }

  clear(): void {
    this.user = {};
    this.persistUser();
    this.notify();
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
  }
}
