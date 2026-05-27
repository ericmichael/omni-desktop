/**
 * Per-key settings layering for teams mode (see docs/teams-settings-merge.md).
 *
 * Each `StoreData` key is classified into one layer/merge class. The composite
 * settings store and the agent-config merge consume this map to decide where a
 * key is read from / written to and how team + user values combine.
 *
 * Classes:
 *   - `team`     — admin-gated team base. MERGED with the user overlay at read
 *                  time per {@link MERGE_OP}; written to `team_settings`.
 *   - `user`     — personal. `scope: 'global'` lives at the user blob's top
 *                  level (follows the user across teams); `scope: 'team'` lives
 *                  under `data.byTeam[teamId]` (per-(user,team) workspace state).
 *   - `identity` — per-user identity (git/github). Lives in `user`-global, but
 *                  the secret bytes resolve against the launching principal.
 *   - `deployment` — operator/env-set; not stored per team/user.
 *   - `infra`    — bookkeeping; kept in the user blob, not user-facing.
 *
 * Keys absent from this map default to `user`/`global` (the personal-first
 * default — most of `StoreData` is personal).
 */
import type { StoreData } from '@/shared/types';

export type SettingsLayer = 'team' | 'user' | 'identity' | 'deployment' | 'infra';
export type UserScope = 'global' | 'team';

/** How a `team`-class key's team base and user overlay combine at read time. */
export type MergeOp =
  | 'union' // collection keyed by id/name; user entry shadows team; user may tombstone
  | 'overlay' // map; user key wins; team may lock keys
  | 'scalar-user-wins' // single value; user ?? team
  | 'providers' // modelsConfig: providers union + user-default
  | 'network'; // deployment floor ∩ team; no user overlay

export interface KeyClass {
  layer: SettingsLayer;
  scope?: UserScope; // for `user`/`identity`/`infra`
  merge?: MergeOp; // for `team`
}

type StoreKey = keyof StoreData;

export const SETTINGS_LAYERS: Partial<Record<StoreKey, KeyClass>> = {
  // ---- team base (admin-gated), merged with user overlay ----
  modelsConfig: { layer: 'team', merge: 'providers' },
  mcpConfig: { layer: 'team', merge: 'union' },
  envVars: { layer: 'team', merge: 'overlay' },
  networkConfig: { layer: 'team', merge: 'network' },
  skillSources: { layer: 'team', merge: 'union' },
  installedBundles: { layer: 'team', merge: 'union' },
  enabledExtensions: { layer: 'team', merge: 'union' },
  customApps: { layer: 'team', merge: 'union' },

  // ---- per-user identity ----
  gitCredentials: { layer: 'identity', scope: 'global' },
  githubAccount: { layer: 'identity', scope: 'global' },

  // ---- user, global (follow the user across teams) ----
  theme: { layer: 'user', scope: 'global' },
  glassTone: { layer: 'user', scope: 'global' },
  codeDeckBackground: { layer: 'user', scope: 'global' },
  layoutMode: { layer: 'user', scope: 'global' },
  codeLayoutMode: { layer: 'user', scope: 'global' },
  audioSettings: { layer: 'user', scope: 'global' },
  previewFeatures: { layer: 'user', scope: 'global' },
  weeklyReviewDay: { layer: 'user', scope: 'global' },
  browserProfiles: { layer: 'user', scope: 'global' },
  browserHistory: { layer: 'user', scope: 'global' },
  browserBookmarks: { layer: 'user', scope: 'global' },

  // ---- user, per-(user, team) workspace state ----
  codeTabs: { layer: 'user', scope: 'team' },
  activeCodeTabId: { layer: 'user', scope: 'team' },
  activeTicketId: { layer: 'user', scope: 'team' },
  wipLimit: { layer: 'user', scope: 'team' },
  chatSessionId: { layer: 'user', scope: 'team' },
  chatProfileName: { layer: 'user', scope: 'team' },
  chatContainerId: { layer: 'user', scope: 'team' },
  browserTabsets: { layer: 'user', scope: 'team' },
  lastWeeklyReviewAt: { layer: 'user', scope: 'team' },
  onboardingComplete: { layer: 'user', scope: 'team' },
  defaultProfileName: { layer: 'user', scope: 'team' },

  // ---- deployment (operator/env) ----
  availableSandboxProfiles: { layer: 'deployment' },
  platform: { layer: 'deployment' },

  // ---- infra / bookkeeping ----
  schemaVersion: { layer: 'infra', scope: 'global' },
  agentConfigMigratedFromFiles: { layer: 'infra', scope: 'global' },
  pagesMigration: { layer: 'infra', scope: 'global' },
};

/** Classify a key, defaulting unmapped keys to personal (user/global). */
export function classify(key: StoreKey): KeyClass {
  return SETTINGS_LAYERS[key] ?? { layer: 'user', scope: 'global' };
}

/** Keys whose team base is admin-gated to write. */
export function isTeamKey(key: StoreKey): boolean {
  return classify(key).layer === 'team';
}

/** Project-data keys are served from the repo, never the settings stores. */
export const PROJECT_DATA_KEYS: ReadonlySet<StoreKey> = new Set<StoreKey>([
  'projects',
  'tickets',
  'milestones',
  'pages',
  'inboxItems',
  'tasks',
]);
