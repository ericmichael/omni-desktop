import type { Rectangle } from 'electron/main';
import type { Schema } from 'electron-store';

import type { CustomAppEntry } from '@/shared/app-registry';
import type { ExtensionDescriptor, ExtensionEnsureResult, ExtensionInstanceState } from '@/shared/extensions';
import type { VoicePersona } from '@/shared/voice-personas';

// Normally we'd use SWR or some query library, but I had some issues with react render cycles and the easiest fix
// was to just move all the fetching outside react. Also SWR doesn't narrow its data field when the request is
// successful, which is suuuuper annoying. This type provides a similar API, but better types. Just have to implement
// the fetching logic yourself.
export type AsyncRequest<T, E> =
  | {
      isUninitialized: true;
      isLoading: false;
      isError: false;
      isSuccess: false;
    }
  | {
      isUninitialized: false;
      isLoading: true;
      isError: false;
      isSuccess: false;
    }
  | {
      isUninitialized: false;
      isLoading: false;
      isError: true;
      isSuccess: false;
      error: E;
    }
  | {
      isUninitialized: false;
      isLoading: false;
      isError: false;
      isSuccess: true;
      data: T;
    };

/**
 * Window size and position properties, used to save and restore window state.
 */
export type WindowProps = {
  bounds: Rectangle;
  isMaximized: boolean;
  isFullScreen: boolean;
};

/**
 * Data stored in the electron store.
 */
export type LayoutMode = 'chat' | 'spaces' | 'projects' | 'dashboards' | 'settings' | 'more' | 'gallery';
export type OmniTheme =
  | 'teams-light'
  | 'teams-dark'
  | 'default'
  | 'tokyo-night'
  | 'vscode-dark'
  | 'vscode-light'
  | 'utrgv';

/**
 * Summary of a sandbox profile available to the launcher. Discovered at
 * runtime by the main process from disk (`<config>/sandbox/*.yml`) plus
 * bundled built-ins. Not persisted to the store — re-derived each boot.
 */
export type ProfileSummary = {
  /** Profile name; matches the YAML filename without extension. */
  name: string;
  /** Human-readable label for UI. */
  label: string;
  /** Sandbox client type from the profile (`unix_local`, `docker`, ...). */
  clientType: string;
  /** True for profiles shipped with the launcher (not user-created). */
  builtin: boolean;
};

/**
 * Platform credentials for enterprise mode.
 * The platform URL is baked in at build time via OMNI_PLATFORM_URL.
 * These credentials are stored after the user signs in via device code flow.
 * When absent, the launcher runs in open-source mode with local Docker.
 */
export type PlatformCredentials = {
  accessToken: string;
  refreshToken: string;
  userEmail?: string;
  userName?: string;
  userRole?: string;
  domains?: Array<{ id: number; name: string; slug: string }>;
};

export type AudioSettings = {
  /** mediaDevices deviceId for the input mic. Null = OS default. */
  inputDeviceId: string | null;
  /** mediaDevices deviceId for output (applied via setSinkId on a routed <audio> element). Null = OS default. */
  outputDeviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

/**
 * Identity claims pulled from the AAD token (id_token / access_token) at
 * link time. Only the bits we display + the oid used for cross-tab identity.
 */
export type CloudAccount = {
  /** Stable AAD object id. Survives email + display-name changes. */
  oid: string;
  /** Display name from the id_token (preferred for UI). */
  name?: string;
  /** Email / UPN. */
  email?: string;
};

export type CloudMode = {
  /** Origin of the launcher cloud (e.g. ``https://omni.example.com``). */
  url: string;
  /** AAD tenant the cloud is registered in. Cached from /.well-known/omni-cloud. */
  tenantId: string;
  /** AAD client id of the launcher's app registration. Used for token refresh. */
  clientId: string;
  account: CloudAccount;
};

export type StoreData = {
  workspaceDir?: string;
  /**
   * Name of the default sandbox profile. Resolved at launch time against
   * the launcher's profile chain (built-in → user-default → per-project).
   * Built-in profiles always present: `host` (no isolation, unix_local) and
   * `devbox` (docker with code-server + VNC). Enterprise adds `platform`.
   */
  defaultProfileName: string;
  /**
   * Sandbox profiles the UI picker should offer. When set by the backend
   * (e.g. a cloud/ACI deployment forces `['aci']` to disable host/devbox),
   * the picker shows exactly these. Unset → the renderer falls back to the
   * built-in list (`host`/`devbox`, plus `platform` on enterprise builds).
   */
  availableSandboxProfiles?: string[];
  launcherWindowProps?: WindowProps;
  appWindowProps?: WindowProps;
  optInToLauncherPrereleases: boolean;
  previewFeatures: boolean;
  /** Local voice (Option A): use on-device Parakeet STT + Pocket TTS instead of a hosted voice model. */
  localVoiceEnabled: boolean;
  /**
   * User-created voice personas (local voice only). Built-in personas (Default,
   * Jarvis) live in code (`shared/voice-personas.ts`), never here.
   */
  voicePersonas: VoicePersona[];
  /** Id of the selected voice persona (built-in or custom). Empty/stale → Default. */
  activeVoicePersonaId: string;

  layoutMode: LayoutMode;
  theme: OmniTheme;
  onboardingComplete: boolean;
  /**
   * Set when the Electron app is connected to a deployed cloud launcher.
   * When non-null the renderer routes its transport to ``url`` over WebSocket
   * (Bearer-authenticated against AAD) instead of using local Electron IPC,
   * so chat sessions, projects, tickets etc. live in the cloud's Postgres
   * and sync to any other Electron / web client signed in as the same user.
   *
   * ``url`` is the launcher origin (no trailing slash).
   * ``tenantId`` + ``clientId`` are discovered from
   * ``<url>/.well-known/omni-cloud`` at link time so the renderer doesn't
   * need them — they're cached here for token refresh.
   * ``account`` is what we display in the UI; the access + refresh tokens
   * themselves live in the local secret store (`git-secrets.json`) under the
   * ``entra`` id.
   * ``null`` is the standalone-Electron mode (today's default).
   */
  cloudMode: CloudMode | null;
  projects: Project[];
  milestones: Milestone[];
  pages: Page[];
  inboxItems: InboxItem[];
  tasks: Task[];
  tickets: Ticket[];
  /** Maximum active tickets across all projects (cognitive WIP limit). Default: 3. */
  wipLimit: number;
  /** Day of week for the weekly review prompt (0=Sun, 1=Mon, ..., 6=Sat). Default: 1 (Monday). */
  weeklyReviewDay: number;
  /** Timestamp (ms) of last completed weekly review. Null if never done. */
  lastWeeklyReviewAt: number | null;
  schemaVersion: number;
  chatSessionId: string | null;
  /**
   * Sticky profile binding for the singleton chat process. Snapshotted from
   * the user's default the first time the chat is launched (or set by the
   * sandbox picker), then persisted so a later change to ``defaultProfileName``
   * doesn't silently move the chat — and its workspace snapshot tar — to a
   * different sandbox. ``null`` only on fresh installs: the chat auto-launch
   * hook mints it from ``defaultProfileName`` on first start.
   */
  chatProfileName: string | null;
  /**
   * Docker container id captured from the last successful chat launch, used
   * on the next start to call ``client.resume(state)`` for warm reattach
   * (preserves running processes / installed packages / shell sessions). The
   * SDK falls back silently to a fresh container + snapshot rehydrate if the
   * container is gone, so a stale id here is never load-bearing. Cleared
   * whenever ``chatProfileName`` changes (a different profile = a different
   * image = a meaningless id).
   */
  chatContainerId: string | null;
  codeTabs: CodeTab[];
  activeCodeTabId: CodeTabId | null;
  codeLayoutMode: CodeLayoutMode;
  /** Optional background image (data URL) rendered behind the Code Deck. */
  codeDeckBackground: string | null;
  /**
   * Wallpaper-derived glass tone. Sampled from `codeDeckBackground` luminance
   * on upload — drives whether glass surfaces use a dark scrim with light
   * text (`'dark'`) or a light scrim with dark text (`'light'`). Independent
   * of the active theme so glass material stays readable on any wallpaper.
   */
  glassTone: 'dark' | 'light';
  activeTicketId: TicketId | null;

  // Enterprise platform (optional — when set, enables enterprise mode)
  platform?: PlatformCredentials;

  /**
   * Per-extension enabled flag. Missing/false means the extension is dormant
   * and never spawns a subprocess. Toggled from Settings → Extensions.
   */
  enabledExtensions: Record<string, boolean>;

  /**
   * How each skill was installed. Missing means discovered locally (user
   * created the directory manually). Persists across sessions so the UI
   * can show provenance (e.g. "Installed from pdf.skill").
   *
   * Enabled/disabled state is determined by directory location:
   * `<configDir>/skills/` = active, `<configDir>/skills-disabled/` = disabled.
   */
  skillSources: Record<string, SkillSource>;

  /**
   * Marketplace bundles the user has installed, keyed by `${repo}:${plugin}`.
   * Records the ref + manifest version + skill names that were on disk at
   * install time, so update checks can diff against the live manifest.
   */
  installedBundles: Record<string, InstalledBundle>;

  /** User-added custom apps for the workspace dock. */
  customApps: CustomAppEntry[];

  /**
   * Stored git credentials (metadata only — token bytes live in the
   * `SecretStore`, keyed by `id`). Host-scoped: a `git-remote` source resolves
   * its credential by matching the URL host. Safe to broadcast to the renderer
   * because it carries no secret. See `git-credentials.ts`.
   */
  gitCredentials: GitCredential[];

  /**
   * Linked GitHub account (display metadata only — the OAuth token lives in the
   * `SecretStore` as the `github.com` credential). Drives the "Connect GitHub"
   * state and repo discovery. Undefined when no account is linked.
   */
  githubAccount?: GithubAccount;

  /**
   * Agent model providers — the source of truth for what the desktop wrote to
   * `models.json`. Materialized to `<configDir>/models.json` at agent launch.
   * In cloud, provider/model `api_key` values are rewritten to `${OMNI_SECRET_*}`
   * refs on disk and the real values injected into the agent env, so secrets
   * never touch the (shared, ephemeral) container disk. See `config-materializer.ts`.
   */
  modelsConfig: ModelsConfig;
  /** Agent MCP servers (`mcp.json`). Same materialization + secret handling as `modelsConfig`. */
  mcpConfig: McpConfig;
  /** Sandbox network egress policy (`network.json`). Non-secret; materialized verbatim. */
  networkConfig: NetworkConfig;
  /**
   * Raw `.env` contents for the agent. On desktop, materialized to a real
   * `.env` file. In cloud, parsed and injected directly into the agent process
   * env (a `.env` *is* the env — no file is written).
   */
  envVars: string;
  /**
   * One-shot guard for the v23 migration that imported pre-existing on-disk
   * `models.json`/`mcp.json`/`network.json`/`.env` into the store keys above.
   * Set once the import runs (desktop + local single-tenant server only — cloud
   * tenants start empty so a shared file never leaks across tenants).
   */
  agentConfigMigratedFromFiles?: boolean;

  /** Voice mode audio device + processing preferences. */
  audioSettings: AudioSettings;

  /** Browser profiles (default + user-created). Always contains at least the built-in default. */
  browserProfiles: BrowserProfile[];
  /**
   * Browser tabsets keyed by id. Conventional ids:
   * - `col:<codeTabId>` — standalone browser column in the code deck.
   * - `dock:<codeTabId>` — per-session browser surface inside the env dock.
   */
  browserTabsets: Record<BrowserTabsetId, BrowserTabset>;
  /** Capped-length visit history, newest first. */
  browserHistory: BrowserHistoryEntry[];
  /** User-curated bookmarks. */
  browserBookmarks: BrowserBookmark[];

  /**
   * One-shot notice surfaced after the v18 pages-relocation migration
   * (Task #18). Present only when (a) the migration found legacy files
   * that still exist on disk and (b) the user hasn't dismissed the
   * notice yet. Cleared when the user clicks dismiss or runs cleanup.
   */
  pagesMigration?: PagesMigrationState;
};

/**
 * Persisted state for the post-migration notice. The summary is captured
 * once on the boot the migration ran and replayed to the renderer until
 * the user acknowledges it.
 */
export type PagesMigrationState = {
  /** Counts of files copied per source bucket. */
  summary: {
    perProjectPagesCopied: number;
    rootPagesFromContextMd: number;
    mcpPagesCopied: number;
    skippedAlreadyMigrated: number;
  };
  /**
   * Legacy directories/files still on disk that the user can safely delete
   * to reclaim space. Absolute paths, sorted.
   */
  legacyPaths: string[];
  /** True once the user dismissed the notice or ran cleanup. */
  acknowledged: boolean;
};

// #region Browser types

export type BrowserProfileId = string;
export type BrowserTabsetId = string;
export type BrowserTabId = string;

/**
 * A browser identity. Each profile maps to an Electron `partition` name so its
 * cookies, localStorage, and cache are isolated from other profiles and from
 * non-browser webviews in the app.
 */
export type BrowserProfile = {
  id: BrowserProfileId;
  label: string;
  /** Electron webview `partition=` attribute, e.g. `persist:browser-default`. */
  partition: string;
  /** True for the built-in default profile. Cannot be deleted. */
  builtin?: boolean;
  /** Non-persistent partition (`partition` starts without `persist:`). */
  incognito?: boolean;
  createdAt: number;
};

/** One open tab within a tabset. */
export type BrowserTab = {
  id: BrowserTabId;
  url: string;
  title?: string;
  favicon?: string;
  /** Per-tab profile override. Falls back to the tabset's profile. */
  profileId?: BrowserProfileId;
  pinned?: boolean;
  createdAt: number;
  lastActiveAt: number;
};

/**
 * A collection of tabs owned by one surface (e.g. one browser column in the
 * code deck, or one per-session dock browser).
 */
export type BrowserTabset = {
  id: BrowserTabsetId;
  profileId: BrowserProfileId;
  tabs: BrowserTab[];
  activeTabId: BrowserTabId | null;
  createdAt: number;
  updatedAt: number;
};

export type BrowserHistoryEntry = {
  id: string;
  url: string;
  title?: string;
  profileId: BrowserProfileId;
  visitedAt: number;
};

export type BrowserBookmark = {
  id: string;
  url: string;
  title: string;
  folder?: string;
  createdAt: number;
};

/** Item returned by the omnibox suggestion service. */
export type BrowserSuggestion = {
  kind: 'history' | 'bookmark' | 'search';
  url: string;
  title?: string;
  /** Higher = more relevant. Used only for sort. */
  score: number;
};

// #endregion

// The electron store uses JSON schema to validate its data.

/**
 * JSON schema for the window properties.
 */
const winSizePropsSchema = {
  type: 'object',
  properties: {
    bounds: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
    },
    isMaximized: { type: 'boolean' },
    isFullScreen: { type: 'boolean' },
  },
};

/**
 * JSON schema for the store data.
 */
export const schema: Schema<StoreData> = {
  workspaceDir: {
    type: 'string',
  },
  defaultProfileName: {
    type: 'string',
    default: 'host',
  },
  launcherWindowProps: winSizePropsSchema,
  appWindowProps: winSizePropsSchema,
  optInToLauncherPrereleases: {
    type: 'boolean',
    default: false,
  },
  previewFeatures: {
    type: 'boolean',
    default: false,
  },
  localVoiceEnabled: {
    type: 'boolean',
    default: false,
  },
  voicePersonas: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        builtin: { type: 'boolean' },
        instructions: { type: 'string' },
        voice: { type: 'object' },
      },
      required: ['id', 'name', 'builtin', 'instructions', 'voice'],
    },
  },
  activeVoicePersonaId: {
    type: 'string',
    default: 'default',
  },

  layoutMode: {
    type: 'string',
    // 'code' and 'os' are pre-v20 names for 'spaces'; kept so existing stores
    // load before the v19→v20 migration runs. Migration converts them.
    enum: ['chat', 'spaces', 'os', 'code', 'projects', 'dashboards', 'settings', 'more', 'gallery'],
    default: 'chat',
  },
  theme: {
    type: 'string',
    enum: ['default', 'tokyo-night', 'vscode-dark', 'vscode-light', 'utrgv'],
    default: 'tokyo-night',
  },
  onboardingComplete: {
    type: 'boolean',
    default: false,
  },
  cloudMode: {
    type: ['object', 'null'],
    default: null,
    properties: {
      url: { type: 'string' },
      tenantId: { type: 'string' },
      clientId: { type: 'string' },
      account: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          oid: { type: 'string' },
        },
        required: ['oid'],
      },
    },
    required: ['url', 'tenantId', 'clientId', 'account'],
  },
  wipLimit: {
    type: 'number',
    default: 3,
  },
  weeklyReviewDay: {
    type: 'number',
    default: 1,
  },
  lastWeeklyReviewAt: {
    type: ['number', 'null'],
    default: null,
  },
  schemaVersion: {
    type: 'number',
    default: 0,
  },
  chatSessionId: {
    type: ['string', 'null'],
    default: null,
  },
  chatProfileName: {
    type: ['string', 'null'],
    default: null,
  },
  chatContainerId: {
    type: ['string', 'null'],
    default: null,
  },
  codeTabs: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        projectId: { type: ['string', 'null'] },
        ticketId: { type: 'string' },
        sessionId: { type: 'string' },
        ticketTitle: { type: 'string' },
        workspaceDir: { type: 'string' },
        profileName: { type: 'string' },
        containerId: { type: 'string' },
        createdAt: { type: 'number' },
      },
      required: ['id', 'createdAt'],
    },
  },
  activeCodeTabId: {
    type: ['string', 'null'],
    default: null,
  },
  codeLayoutMode: {
    type: 'string',
    // 'deck' and 'spaces' are pre-v20 names for 'tile'; kept so existing
    // stores load before the v19→v20 migration runs. Migration converts them.
    enum: ['tile', 'spaces', 'deck', 'focus'],
    default: 'tile',
  },
  codeDeckBackground: {
    type: ['string', 'null'],
    default: null,
  },
  activeTicketId: {
    type: ['string', 'null'],
    default: null,
  },
  projects: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        slug: { type: 'string' },
        isPersonal: { type: 'boolean' },
        sources: { type: 'array', default: [] },
        createdAt: { type: 'number' },
        pipeline: { type: 'object' },
        sandboxProfile: { type: ['string', 'null'] },
        dueDate: { type: 'number' },
        pinnedAt: { type: 'number' },
        seedKey: { type: 'string' },
      },
      required: ['id', 'label', 'slug', 'createdAt'],
    },
  },
  milestones: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        projectId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        branch: { type: 'string' },
        brief: { type: 'string' },
        status: { type: 'string', enum: ['active', 'completed', 'archived'] },
        dueDate: { type: 'number' },
        completedAt: { type: 'number' },
        pinnedAt: { type: 'number' },
        createdAt: { type: 'number' },
        updatedAt: { type: 'number' },
        seedKey: { type: 'string' },
      },
      required: ['id', 'projectId', 'title', 'description', 'status', 'createdAt', 'updatedAt'],
    },
  },
  pages: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        projectId: { type: 'string' },
        parentId: { type: ['string', 'null'] },
        title: { type: 'string' },
        icon: { type: 'string' },
        sortOrder: { type: 'number' },
        isRoot: { type: 'boolean' },
        kind: { type: 'string', enum: ['doc', 'notebook'] },
        createdAt: { type: 'number' },
        updatedAt: { type: 'number' },
        seedKey: { type: 'string' },
      },
      required: ['id', 'projectId', 'title', 'sortOrder', 'createdAt', 'updatedAt'],
    },
  },
  inboxItems: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        note: { type: 'string' },
        attachments: { type: 'array', items: { type: 'string' } },
        projectId: { type: ['string', 'null'] },
        status: { type: 'string', enum: ['new', 'shaped', 'later'] },
        shaping: {
          type: 'object',
          properties: {
            outcome: { type: 'string' },
            appetite: { type: 'string', enum: ['small', 'medium', 'large', 'xl'] },
            notDoing: { type: 'string' },
          },
        },
        laterAt: { type: 'number' },
        promotedTo: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['ticket', 'project'] },
            id: { type: 'string' },
            at: { type: 'number' },
          },
          required: ['kind', 'id', 'at'],
        },
        createdAt: { type: 'number' },
        updatedAt: { type: 'number' },
        seedKey: { type: 'string' },
      },
      required: ['id', 'title', 'status', 'createdAt', 'updatedAt'],
    },
  },
  tasks: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        projectId: { type: 'string' },
        taskDescription: { type: 'string' },
        status: { type: 'object' },
        createdAt: { type: 'number' },
        branch: { type: 'string' },
        worktreePath: { type: 'string' },
        worktreeName: { type: 'string' },
        sessionId: { type: 'string' },
        ticketId: { type: 'string' },
        phaseId: { type: 'string' },
        columnId: { type: 'string' },
        iteration: { type: 'number' },
      },
      required: ['id', 'projectId', 'taskDescription', 'status', 'createdAt'],
    },
  },
  tickets: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        projectId: { type: 'string' },
        milestoneId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        blockedBy: { type: 'array', items: { type: 'string' } },
        shaping: {
          type: 'object',
          properties: {
            doneLooksLike: { type: 'string' },
            appetite: { type: 'string', enum: ['small', 'medium', 'large'] },
            outOfScope: { type: 'string' },
          },
        },
        createdAt: { type: 'number' },
        updatedAt: { type: 'number' },
        phaseChangedAt: { type: 'number' },
        columnChangedAt: { type: 'number' },
        resolvedAt: { type: 'number' },
        archivedAt: { type: 'number' },
        cleanupPending: { type: 'boolean' },
        // Per-source map keyed by ProjectSource.id (last sync-to-host timestamps).
        prMergedAt: { type: 'object' },
        assignee: { type: 'string' },
        // Kanban fields
        columnId: { type: 'string' },
        currentPhaseId: { type: ['string', 'null'] },
        phases: { type: 'array', default: [] },
        // Legacy fields (kept for migration)
        taskId: { type: 'string' },
        loopEnabled: { type: 'boolean' },
        loopMaxIterations: { type: 'number' },
        loopIteration: { type: 'number' },
        loopStatus: { type: 'string', enum: ['running', 'completed', 'stopped', 'error'] },
        seedKey: { type: 'string' },
      },
      required: ['id', 'projectId', 'title', 'description', 'priority', 'blockedBy', 'createdAt', 'updatedAt'],
    },
  },
  platform: {
    type: 'object',
    properties: {
      accessToken: { type: 'string' },
      refreshToken: { type: 'string' },
      userEmail: { type: 'string' },
      userName: { type: 'string' },
      userRole: { type: 'string' },
      domains: { type: 'array', items: { type: 'object' } },
    },
  },
  enabledExtensions: {
    type: 'object',
    additionalProperties: { type: 'boolean' },
    default: {},
  },
  skillSources: {
    type: 'object',
    additionalProperties: { type: 'object' },
    default: {},
  },
  installedBundles: {
    type: 'object',
    additionalProperties: { type: 'object' },
    default: {},
  },
  customApps: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        icon: { type: 'string' },
        url: { type: 'string' },
        order: { type: 'number' },
        columnScoped: { type: 'boolean' },
      },
      required: ['id', 'label', 'icon', 'url', 'order'],
    },
  },
  gitCredentials: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        host: { type: 'string' },
        username: { type: 'string' },
        last4: { type: 'string' },
        label: { type: 'string' },
        createdAt: { type: 'number' },
      },
      required: ['id', 'host', 'username', 'last4', 'createdAt'],
    },
  },
  glassTone: { type: 'string', default: 'dark' },
  modelsConfig: {
    type: 'object',
    default: { version: 3, default: null, voice_default: null, providers: {} },
  },
  mcpConfig: { type: 'object', default: { mcpServers: {} } },
  networkConfig: {
    type: 'object',
    default: {
      enabled: false,
      presets: [],
      allowlist: [],
      denylist: [],
      allow_private_ips: false,
      enable_socks5: false,
    },
  },
  envVars: { type: 'string', default: '' },
  agentConfigMigratedFromFiles: { type: 'boolean', default: false },
  audioSettings: {
    type: 'object',
    default: {
      inputDeviceId: null,
      outputDeviceId: null,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    properties: {
      inputDeviceId: { type: ['string', 'null'] },
      outputDeviceId: { type: ['string', 'null'] },
      echoCancellation: { type: 'boolean' },
      noiseSuppression: { type: 'boolean' },
      autoGainControl: { type: 'boolean' },
    },
    required: ['inputDeviceId', 'outputDeviceId', 'echoCancellation', 'noiseSuppression', 'autoGainControl'],
  },
  browserProfiles: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        partition: { type: 'string' },
        builtin: { type: 'boolean' },
        incognito: { type: 'boolean' },
        createdAt: { type: 'number' },
      },
      required: ['id', 'label', 'partition', 'createdAt'],
    },
  },
  browserTabsets: {
    type: 'object',
    default: {},
    additionalProperties: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        profileId: { type: 'string' },
        tabs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              url: { type: 'string' },
              title: { type: 'string' },
              favicon: { type: 'string' },
              profileId: { type: 'string' },
              pinned: { type: 'boolean' },
              createdAt: { type: 'number' },
              lastActiveAt: { type: 'number' },
            },
            required: ['id', 'url', 'createdAt', 'lastActiveAt'],
          },
        },
        activeTabId: { type: ['string', 'null'] },
        createdAt: { type: 'number' },
        updatedAt: { type: 'number' },
      },
      required: ['id', 'profileId', 'tabs', 'activeTabId', 'createdAt', 'updatedAt'],
    },
  },
  browserHistory: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
        profileId: { type: 'string' },
        visitedAt: { type: 'number' },
      },
      required: ['id', 'url', 'profileId', 'visitedAt'],
    },
  },
  browserBookmarks: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
        folder: { type: 'string' },
        createdAt: { type: 'number' },
      },
      required: ['id', 'url', 'title', 'createdAt'],
    },
  },
};

/**
 * The type of GPU in the system. This and the operating system are used to determine:
 * - Whether to install xformers - torch's own SDP is faster for 30xx + series GPUs, otherwise xformers is faster.
 * - Which pypi indices to use for torch.
 */
export type GpuType = 'nvidia<30xx' | 'nvidia>=30xx' | 'amd' | 'nogpu';

/**
 * A map of GPU types to human-readable names.
 */
export const GPU_TYPE_MAP: Record<GpuType, string> = {
  'nvidia<30xx': 'Nvidia (20xx and below)',
  'nvidia>=30xx': 'Nvidia (30xx and above)',
  amd: 'AMD',
  nogpu: 'No dedicated GPU',
};

/**
 * Supported operating systems.
 */
export type OperatingSystem = 'Windows' | 'macOS' | 'Linux';

/**
 * A utility type that prefixes all keys in an object with a string using the specified separator.
 */
type Namespaced<Prefix extends string, T, Sep extends string = ':'> = {
  [K in keyof T as `${Prefix}${Sep}${string & K}`]: T[K];
};

/**
 * A status object that may optionally contain data. It represents an OK/good status.
 */
type OkStatus<StatusType extends string, Data = void> = Data extends void
  ? {
      type: StatusType;
    }
  : {
      type: StatusType;
      data: Data;
    };

/**
 * A status object that contains an error message and optionally some context. It represents an ERROR/bad status.
 *
 * `kind` is an optional discriminant the renderer reads to render specialised
 * banners (e.g. `'host-offline'` triggers the "your laptop is offline" banner
 * with the machine label; `'machine-at-capacity'` triggers the "stop a
 * session or switch to cloud" banner). Absent `kind` ⇒ generic "something
 * went wrong" surface with `message`.
 */
type ErrorStatus = {
  type: 'error';
  error: {
    message: string;
    kind?: 'host-offline' | 'machine-at-capacity' | 'message';
    /** Populated when `kind === 'host-offline' | 'machine-at-capacity'`. */
    machineId?: string;
    /** Populated when `kind === 'host-offline' | 'machine-at-capacity'`. */
    machineLabel?: string;
    /** Populated when `kind === 'machine-at-capacity'`. */
    maxSessions?: number;
    /** Populated when `kind === 'machine-at-capacity'`. */
    currentSessions?: number;
    context?: Record<string, unknown>;
  };
};

/**
 * A status object that may be either an OK status or an ERROR status.
 */
type Status<State extends string> = OkStatus<State> | ErrorStatus;

/**
 * The various states the main process can be in.
 */
export type MainProcessStatus = Status<'initializing' | 'idle' | 'exiting'>;

export type OmniInstallProcessStatus = Status<
  'uninitialized' | 'starting' | 'installing' | 'canceling' | 'exiting' | 'completed' | 'canceled'
>;

// Unified agent process data — emitted by `omni serve` and the platform path.
export type AgentProcessData = {
  /** Base URL the renderer parses for WS + HTTP endpoints. */
  uiUrl: string;
  /** Direct WS URL for JSON-RPC; renderer derives from uiUrl if unset. */
  wsUrl?: string;
  /** Same shape as uiUrl today — kept for status/debug surfaces. */
  sandboxUrl?: string;
  /**
   * Named services running inside the sandbox session, keyed by profile
   * service name (`code_server`, `vnc`, ...). Each value is a host URL the
   * renderer can iframe directly. Empty when the profile defines no services.
   */
  services?: Record<string, string>;
  /** Container id when the backend is docker; absent for unix_local/platform. */
  containerId?: string;
  /** Container name when the backend is docker. */
  containerName?: string;
  /** Host port the agent's WS/HTTP server is bound to. */
  port?: number;
  /**
   * Which fallback tier the SDK's resume path took for this start. Only
   * meaningful when the launcher passed a previous container id back:
   *   - ``'reused'``    — warm reattach succeeded (everything survived)
   *   - ``'rehydrated'`` — old container gone; fresh container + snapshot tar
   *                       (workspace files survived, runtime state didn't)
   *   - ``'fresh'``     — both gone; manifest-only seed
   *   - ``undefined``   — no resume was requested (first launch / non-docker)
   *
   * The renderer toasts on ``'rehydrated'`` so the user understands why their
   * running dev server / shell session went away.
   */
  resume?: 'reused' | 'rehydrated' | 'fresh';
  /**
   * True when the sandbox container is currently frozen via docker pause
   * (cgroup freezer). RAM is held; CPU is zero; tool calls into the
   * container hang until unpause. The renderer uses this to show a
   * "paused" badge and to trigger ``sandbox.unpause`` on activity.
   * Unset / false when the backend doesn't support pause or when we
   * never asked.
   */
  paused?: boolean;
  /**
   * True while an in-place sandbox switch is running (`sandbox.switch`): the
   * process and WS stay up, but the sandbox is being torn down + rebuilt. The
   * renderer overlays a "Switching to <profile>…" scrim over the (still-mounted)
   * conversation and reloads the service panes when it clears.
   */
  switching?: boolean;
  /**
   * Computer-as-sandbox: true while the laptop hosting this session's sandbox
   * (`local:<machineId>`) is offline (its WS to the cloud dropped). The agent
   * itself keeps running in the cloud — chat history + the conversation UI stay
   * up — but its tools (exec/file/PTY) are unreachable. The renderer overlays a
   * non-destructive "Your laptop is offline" banner over the still-running
   * session rather than tearing it down. Cleared (and the sandbox re-established)
   * when the laptop reconnects.
   */
  hostOffline?: boolean;
  /** Friendly label of the offline host, for the banner. */
  hostOfflineMachineLabel?: string;
  /**
   * Where this agent process is anchored — `'cloud'` for ACI/platform/local-
   * laptop-running-omni-serve, `{kind: 'local', machineId}` for sessions the
   * cloud dispatched to a registered Electron via reverse-RPC. Used by
   * Settings → Machines and (Phase 7) the developer logs to associate
   * activity with the right machine.
   */
  computeLocation?: 'cloud' | { kind: 'local'; machineId: string };
};

export type AgentProcessStatus =
  | Status<'uninitialized' | 'starting' | 'stopping' | 'exiting' | 'exited'>
  | OkStatus<'connecting', AgentProcessData>
  | OkStatus<'running', AgentProcessData>;

/**
 * Start argument for the unified agent process manager.
 */
export type AgentProcessStartOptions = {
  workspaceDir: string;
  /**
   * Project id, when this agent process belongs to a project. Forwarded to
   * `omni serve --project <id>` so the per-project profile layer
   * (`<config>/projects/<id>/sandbox.yml`) is resolved.
   */
  projectId?: string;
  /**
   * Per-launch profile override. Wins over per-project ``sandboxProfile``
   * and the user's ``defaultProfileName``. Set by the pre-launch sandbox
   * picker; not persisted — a follow-up launch without this set falls
   * back through the normal resolution chain.
   */
  profileNameOverride?: string;
  /**
   * Conversation session id — the SAME id used to scope chat history and
   * WebSocket ``serverCall`` traffic in the omniagents server. Used as
   * the snapshot key, so each conversation gets its own workspace state.
   *
   * Caller eagerly generates this when starting a fresh conversation
   * (uuid) and persists on the owning record (``StoreData.chatSessionId``
   * or ``CodeTab.sessionId``), then passes it both here AND as the
   * ``sessionId`` prop to OmniAgentsApp so the agent server uses the
   * same id for its session.
   */
  sessionId?: string;
  /**
   * Docker container id from a previous launch. Passed to omni serve as
   * ``--container-id`` so the SDK can attempt a warm reattach via
   * ``client.resume(state)`` instead of always creating a fresh container.
   * If the container is no longer alive, the SDK silently falls back to
   * fresh container + snapshot rehydrate — a stale id is never an error,
   * just a missed opportunity for warm reattach.
   */
  containerId?: string;
};

/**
 * A logging level.
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * A log entry with a level and message.
 */
export type LogEntry = {
  level: LogLevel;
  message: string;
};

/**
 * A type that adds a timestamp to an object.
 */
export type WithTimestamp<T> = T & { timestamp: number };

export type OmniRuntimeInfo =
  | {
      isInstalled: false;
    }
  | {
      isInstalled: true;
      version: string;
      expectedVersion: string;
      isOutdated: boolean;
      pythonVersion: string;
      omniPath: string;
    };

// #region Code Tab types

export type CodeTabId = string;

export type CodeLayoutMode = 'tile' | 'focus';

export type CodeTab = {
  id: CodeTabId;
  projectId: ProjectId | null;
  ticketId?: TicketId;
  sessionId?: string;
  ticketTitle?: string;
  workspaceDir?: string;
  /** When set, this tab renders as a global app column (webview) instead of an agent session. */
  customAppId?: string;
  /**
   * Sticky profile binding for this tab. Snapshotted from the resolution chain
   * (per-project ``sandboxProfile`` → user default) when the tab is created,
   * then persisted so a later default change doesn't silently drift the
   * workspace into another sandbox.
   */
  profileName?: string;
  profileNameExplicit?: boolean;
  /**
   * Docker container id captured from the last successful launch of this tab.
   * Sent back on the next start so omni-code can ``client.resume(state)`` for
   * warm reattach. Stale ids are safe — the SDK falls back to fresh container
   * + snapshot rehydrate. Cleared whenever ``profileName`` changes.
   */
  containerId?: string;
  createdAt: number;
};

// #endregion

// #region Project & Ticket types

// --- ID types ---

export type ProjectId = string;

/**
 * Minimal pointer the launcher persists so it knows where each project's
 * file-backed data lives. All other project attributes are loaded from
 * `<dir>/.omni/project.yml` at runtime.
 */
export type ProjectIndexEntry = { id: ProjectId; dir: string };

export type MilestoneId = string;
export type PageId = string;
export type InboxItemId = string;
export type TaskId = string;
export type TicketId = string;
export type TicketCommentId = string;
export type ColumnId = string;

// --- Enums ---

export type TicketPriority = 'low' | 'medium' | 'high' | 'critical';
export type TicketResolution = 'completed' | 'wont_do' | 'duplicate' | 'cancelled';
export type MilestoneStatus = 'active' | 'completed' | 'archived';

/** Re-export TicketPhase so renderer can import from shared/types. */
export type { TicketPhase } from '@/shared/ticket-phase';

/** Accumulated token usage for a supervisor session. */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

// --- Pipeline & columns ---

/**
 * A single column in the kanban pipeline. Visual milestones for the supervisor.
 */
export type Column = {
  id: ColumnId;
  label: string;
  /** Human-readable description of what this column represents. */
  description?: string;
  /** Max concurrent supervisors allowed in this column. Unlimited if undefined. */
  maxConcurrent?: number;
  /** When true, the supervisor is stopped on entry and only a human can move the ticket out. */
  gate?: boolean;
};

/**
 * The pipeline definition for a project. Ordered list of columns.
 */
export type Pipeline = {
  columns: Column[];
};

// --- Core entities ---

/**
 * A stored git credential, keyed by host. Credentials are host-scoped and
 * resolved implicitly: a `git-remote` source authenticates with the entry whose
 * `host` matches the source URL's host, so a token is entered once per host and
 * reused across every project. This object holds *metadata only* — the token
 * bytes live in the main/server `SecretStore` (keyed by `id`) and never enter
 * the renderer or the `store:changed` snapshot. See `git-credentials.ts`.
 */
export type GitCredential = {
  id: string;
  /** Bare host the token authenticates, e.g. `github.com`, `gitlab.example.org`. */
  host: string;
  /**
   * HTTPS basic-auth username paired with the token. GitHub PATs use
   * `x-access-token`; GitLab uses `oauth2`. Editable for other hosts.
   */
  username: string;
  /** Last 4 chars of the token, for display only. Never the token itself. */
  last4: string;
  /** Optional human label shown in the credential list. */
  label?: string;
  createdAt: number;
};

/**
 * Linked GitHub account metadata (display only — the OAuth token lives in the
 * `SecretStore` as the `github.com` [[GitCredential]]). Connecting an account
 * both authenticates clone/push and unlocks repo discovery. Safe to broadcast
 * to the renderer.
 */
export type GithubAccount = {
  login: string;
  avatarUrl?: string;
  /** OAuth scopes granted on the stored token (e.g. `repo`, `read:org`). */
  scopes?: string[];
  /** API host the account is on — `github.com` or a GitHub Enterprise host. */
  host: string;
  connectedAt: number;
};

/** Connection status for the linked GitHub account. */
export type GithubStatus = { connected: boolean; account?: GithubAccount };

/** An account that owns repositories — the linked user, or an org they belong
 *  to. Drives the owner selector in the repo picker. */
export type GithubOwner = { login: string; kind: 'user' | 'org'; avatarUrl?: string };

/** A scoped repo query: search `query` within one owner. Empty `query` returns
 *  that owner's most-recently-pushed repos. */
export type GithubRepoQuery = { owner: string; kind: 'user' | 'org'; query: string };

/** A repository discovered via a linked provider (GitHub, Azure DevOps, …), for
 *  the source picker. Provider-agnostic. */
export type RemoteRepo = {
  /** `owner/name` (GitHub) or `project/repo` (Azure DevOps). */
  fullName: string;
  /** HTTPS clone URL. */
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  /** Last push time (epoch ms) — drives most-recent-first ordering. */
  pushedAt?: number;
};

/**
 * Device-flow user code, pushed to the renderer mid-link so the connect UI can
 * display the code the user must enter at `verificationUri`.
 */
export type GithubDeviceCode = { userCode: string; verificationUri: string; expiresIn: number };

/**
 * One repo/directory attached to a project. Projects can have any number
 * of sources (zero, one, or many) — a cross-cutting ticket like "ship a
 * change across launcher + omni-code + omniagents" attaches three sources
 * to one project so the agent sees all three at once in /workspace.
 *
 * - `id`: stable identifier (nanoid). Reviews + merge state on tickets key
 *   off this so renaming the user-facing ``mountName`` doesn't orphan
 *   per-source PR state.
 * - `mountName`: subdirectory under ``/workspace/`` inside the container
 *   (e.g. ``launcher``). Defaults to a slug derived from path or repo
 *   name; must be unique within a project.
 * - `kind`: `local` (host directory) or `git-remote` (URL the container
 *   clones; private repos authenticate with the host-matched
 *   [[GitCredential]], resolved at clone time — never stored on the source).
 */
export type ProjectSource = (
  | { kind: 'local'; workspaceDir: string; gitDetected?: boolean }
  | { kind: 'git-remote'; repoUrl: string; defaultBranch?: string }
) & {
  id: string;
  mountName: string;
};

/**
 * Single-source ergonomic accessor: the first source attached to a project,
 * or undefined if none. Use this for callers that conceptually want "the
 * project's repo" — the launcher's legacy code paths and the MCP API
 * (which doesn't model multi-source).
 *
 * Multi-source-aware callers (PR UI, container seeding, per-source merge)
 * iterate ``project.sources`` directly.
 */
export const firstSource = (project: { sources: ProjectSource[] } | undefined | null): ProjectSource | undefined =>
  project?.sources[0];

export type Project = {
  id: ProjectId;
  label: string;
  /** Filesystem-safe name derived from label, used for project folder path. */
  slug: string;
  /** True for the auto-created Personal project. Cannot be deleted. */
  isPersonal?: boolean;
  /**
   * Repos/directories attached to this project. Empty array = no source.
   * The container exposes each source under ``/workspace/<mountName>``.
   */
  sources: ProjectSource[];
  createdAt: number;
  /** Pipeline configuration. If undefined, DEFAULT_PIPELINE is used. */
  pipeline?: Pipeline;
  /** When true, automatically dispatch tickets from backlog in priority order. */
  autoDispatch?: boolean;
  /**
   * Per-project sandbox profile name. Overrides ``defaultProfileName`` for
   * this project. ``null``/missing inherits the user-default.
   */
  sandboxProfile?: string | null;
  /** Optional target date (epoch ms). Drives deadline-pressure risk signals. */
  dueDate?: number;
  /** Timestamp of the most recent pin action. Set = pinned to Home; undefined = not pinned. */
  pinnedAt?: number;
  /** Populated by the seed script; tracked in seed-manifest for reset. */
  seedKey?: string;
};

export type Milestone = {
  id: MilestoneId;
  projectId: ProjectId;
  title: string;
  description: string;
  /** Optional feature branch. Tickets inherit this unless they override with their own branch. */
  branch?: string;
  /** Milestone brief — describes the deliverable, goals, and scope. */
  brief?: string;
  status: MilestoneStatus;
  /** Optional target date (epoch ms). Drives deadline-pressure risk signals. */
  dueDate?: number;
  /** Stamped when status transitions to 'completed'. */
  completedAt?: number;
  /** Timestamp of the most recent pin action. Set = pinned to Home; undefined = not pinned. */
  pinnedAt?: number;
  createdAt: number;
  updatedAt: number;
  /** Populated by the seed script; tracked in seed-manifest for reset. */
  seedKey?: string;
};

/**
 * A knowledge-base page. Notion-style: hierarchical doc with a title, icon,
 * and markdown body (stored on disk, not in the store). Pages have no
 * lifecycle status — they are docs, not work items. Work happens on tickets.
 */
export type PageKind = 'doc' | 'notebook';

export type PageProperties = {
  status?: string;
  size?: string;
  projectId?: ProjectId;
  milestoneId?: MilestoneId;
  outcome?: string;
  notDoing?: string;
  laterAt?: number;
};

export type Page = {
  id: PageId;
  projectId: ProjectId;
  /** Null for root-level pages in the project. */
  parentId: PageId | null;
  title: string;
  /** Emoji for sidebar display. */
  icon?: string;
  /** Sort position among siblings. Lower = first. */
  sortOrder: number;
  /** True for the auto-created root page. Cannot be deleted. */
  isRoot?: boolean;
  /**
   * Content kind. 'doc' (default) is a Yoopta markdown page stored as `.md`.
   * 'notebook' is a marimo notebook stored as `.py`, edited via the marimo
   * extension's webview surface. Root pages are always 'doc'.
   */
  kind?: PageKind;
  /** Structured metadata fields (status, size, outcome, etc.) for this page. */
  properties?: PageProperties;
  createdAt: number;
  updatedAt: number;
  /** Populated by the seed script; tracked in seed-manifest for reset. */
  seedKey?: string;
};

// --- Inbox ---

/**
 * GTD-style inbox lifecycle:
 * - new:    captured, not yet shaped
 * - shaped: has a filled-in `shaping` block, ready to promote
 * - later:  deferred; `laterAt` drives stale-item reminders
 *
 * Terminal transition is promotion: the item is stamped with `promotedTo`
 * pointing at the ticket or project it became, and is filtered out of the
 * active inbox view. Promoted items stay as tombstones for undo + audit
 * (GC'd after 30d by the inbox manager).
 */
export type InboxItemStatus = 'new' | 'shaped' | 'later';

export type InboxShaping = {
  /** 1-2 sentences — what does success look like? (Shape Up "done looks like"). */
  outcome: string;
  /** Rough effort sizing. */
  appetite: 'small' | 'medium' | 'large' | 'xl';
  /** Explicit exclusions — what is NOT in scope. */
  notDoing?: string;
};

export type InboxPromotion = {
  kind: 'ticket' | 'project';
  /** ID of the ticket or project this inbox item became. */
  id: string;
  /** Timestamp of promotion, used for tombstone GC. */
  at: number;
};

export type InboxItem = {
  id: InboxItemId;
  title: string;
  /** Free-form capture body. */
  note?: string;
  attachments?: string[];
  /** Optional project context at capture time. Null = loose / global. */
  projectId?: ProjectId | null;
  status: InboxItemStatus;
  /** Present once the item has been shaped. Required for promotion to ticket. */
  shaping?: InboxShaping;
  /** Stamped when moved to `later`. Drives the stale-items reminder. */
  laterAt?: number;
  /** Stamped on promotion. Presence hides the item from the active view. */
  promotedTo?: InboxPromotion;
  createdAt: number;
  updatedAt: number;
  /** Populated by the seed script; tracked in seed-manifest for reset. */
  seedKey?: string;
};

export type TicketComment = {
  id: TicketCommentId;
  author: 'agent' | 'human';
  content: string;
  createdAt: number;
};

export type TicketRun = {
  id: string;
  startedAt: number;
  endedAt: number;
  endReason: string;
  tokenUsage?: TokenUsage;
};

export type PullRequestLink = {
  url: string;
  number: number;
  state: string;
  projectId: ProjectId;
  sourceId: string;
  sourceMountName: string;
  provider?: 'github' | 'azure';
  branch?: string;
  title?: string;
  ticketId?: TicketId;
  codeTabId?: CodeTabId;
  sessionId?: string;
  workspaceDir?: string;
  createdAt: number;
  lastSeenAt: number;
};

export type Ticket = {
  id: TicketId;
  projectId: ProjectId;
  milestoneId?: MilestoneId;
  title: string;
  description: string;
  priority: TicketPriority;
  blockedBy: TicketId[];
  createdAt: number;
  updatedAt: number;

  /** Shaping data carried from inbox — scope, appetite, boundaries. */
  shaping?: ShapingData;

  // Kanban state
  /** Current column in the kanban pipeline. */
  columnId: ColumnId;

  // Git settings
  /** Git branch to work on. If set with useWorktree, a worktree is created from this branch. */
  branch?: string;
  /** Whether to create an isolated git worktree for this ticket's sandbox. */
  useWorktree?: boolean;

  // Worktree state (persisted so worktrees survive server restarts)
  /** Path to the git worktree on disk. */
  worktreePath?: string;
  /** Name of the git worktree (used for branch naming). */
  worktreeName?: string;
  /**
   * Set when the ticket was moved to the terminal column but the worktree
   * had uncommitted changes, so cleanup was deferred. The worktree + sandbox
   * stay alive until the user explicitly finalizes via `project:finalize-ticket-cleanup`.
   */
  cleanupPending?: boolean;

  // --- Sync to host (per source) ---
  /**
   * Stamped per source when that source's container changes were last applied
   * to its host working copy ("synced"). Keyed by ``ProjectSource.id``.
   * (Legacy DB column name: ``pr_merged_at``.)
   */
  prMergedAt?: Record<string, number>;

  // Supervisor state
  /** True when autopilot is driving this ticket. Flipped by start/stopSupervisor. */
  autopilot?: boolean;
  /** Current supervisor lifecycle phase. */
  phase?: import('@/shared/ticket-phase').TicketPhase;
  /** Stamped whenever `phase` transitions. Drives stalled-ticket risk. */
  phaseChangedAt?: number;
  /** Stamped whenever `columnId` changes. Drives aging-in-column risk. */
  columnChangedAt?: number;
  /** Stamped when `resolution` first becomes defined. Drives shipped-today/week. */
  resolvedAt?: number;
  /** Task ID for the supervisor's sandbox. */
  supervisorTaskId?: TaskId;
  /** Accumulated token usage across all supervisor runs. */
  tokenUsage?: TokenUsage;
  /** Resolution reason when ticket is closed. Undefined means open. */
  resolution?: TicketResolution;
  /** Timestamp when the ticket was archived from active views. */
  archivedAt?: number;
  /** Agent/human comments — serves as persistent memory across runs. */
  comments?: TicketComment[];
  /**
   * Assigned member's principal id (cloud/teams). Drives per-user WIP and the
   * weekly review ("my work"). Undefined = unassigned; single-user (Electron/
   * local) installs leave it unset.
   */
  assignee?: string;
  /** History of supervisor runs on this ticket. */
  runs?: TicketRun[];
  pullRequests?: PullRequestLink[];
  /** Populated by the seed script; tracked in seed-manifest for reset. */
  seedKey?: string;
};

// --- Shaping ---

export type Appetite = 'small' | 'medium' | 'large';

export type ShapingData = {
  /** 1-2 sentences: what is true when this is done? */
  doneLooksLike: string;
  /** How much time is this worth? small=day, medium=few days, large=week+ */
  appetite: Appetite;
  /** What's explicitly excluded from scope. */
  outOfScope: string;
};

export type Task = {
  id: TaskId;
  projectId: ProjectId;
  taskDescription: string;
  status: WithTimestamp<AgentProcessStatus>;
  createdAt: number;
  branch?: string;
  worktreePath?: string;
  worktreeName?: string;
  sessionId?: string;
  ticketId?: TicketId;
  /** Snapshot of sandbox URLs from the last 'running' state, for replaying past sessions. */
  lastUrls?: {
    uiUrl: string;
    codeServerUrl?: string;
    noVncUrl?: string;
  };
};

export type ArtifactFileEntry = {
  relativePath: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
};

export type ArtifactFileContent = {
  relativePath: string;
  mimeType: string;
  textContent: string | null;
  size: number;
};

/**
 * Which source the change came from:
 *   - committed: between `base` and `HEAD` (what a PR would land)
 *   - staged: between `HEAD` and the index (git add)
 *   - unstaged: between the index and the working tree
 *   - untracked: new file not tracked by git
 * A single path can appear under multiple groups when its change spans several.
 */
export type DiffGroup = 'committed' | 'staged' | 'unstaged' | 'untracked';

export type FileDiff = {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked';
  group: DiffGroup;
  additions: number;
  deletions: number;
  isBinary: boolean;
  patch?: string;
};

export type DiffResponse = {
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  hasChanges: boolean;
  files: FileDiff[];
};

export type SessionMessage = {
  id: number;
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result';
  content: string;
  toolName?: string;
  createdAt: string;
};

export type GitRepoInfo = { isGitRepo: true; branches: string[]; currentBranch: string } | { isGitRepo: false };

/**
 * Result of a dry-run merge check for a ticket's feature branch → base.
 * `ready` is false when the ticket has no worktree / base / feature branch;
 * conflict info is surfaced in `conflictingFiles` when `ready` is true.
 */
export type PrMergeCheck =
  | { ready: false; reason: string }
  | {
      ready: true;
      base: string;
      feature: string;
      hasConflicts: boolean;
      conflictingFiles: string[];
      /** Commits on the feature branch not present on base. Zero means nothing to merge. */
      ahead: number;
    };

export type PrMergeResult = { ok: true; mergeCommitSha: string } | { ok: false; error: string };

/**
 * A GitHub pull request detected for one source's branch by running
 * ``gh pr view`` inside the running container (where the agent pushed the
 * branch and ``gh`` is authenticated). Absent (null) when the source has no
 * open PR — e.g. a plain local directory, a git repo with no remote, or a
 * branch the agent hasn't opened a PR for yet.
 */
export interface ContainerPullRequest {
  number: number;
  url: string;
  state: string;
  title?: string;
  sourceId?: string;
  sourceMountName?: string;
  projectId?: ProjectId;
  ticketId?: TicketId;
  codeTabId?: CodeTabId;
  sessionId?: string;
  workspaceDir?: string;
  provider?: 'github' | 'azure';
  branch?: string;
}

// #endregion

/**
 * Store API. Main process handles these events, renderer process invokes them.
 */
type StoreIpcEvents = Namespaced<
  'store',
  {
    'get-key': <K extends keyof StoreData>(key: K) => StoreData[K];
    'set-key': <K extends keyof StoreData>(key: K, val: StoreData[K]) => void;
    get: () => StoreData;
    set: (data: StoreData) => void;
    reset: () => void;
  }
>;

/**
 * Main Process API. Main process handles these events, renderer process invokes them.
 */
type MainProcessIpcEvents = Namespaced<
  'main-process',
  {
    'get-status': () => WithTimestamp<MainProcessStatus>;
    exit: () => void;
  }
>;

type OmniInstallProcessIpcEvents = Namespaced<
  'omni-install-process',
  {
    'get-status': () => WithTimestamp<OmniInstallProcessStatus>;
    'start-install': (repair?: boolean) => void;
    'cancel-install': () => void;
    resize: (cols: number, rows: number) => void;
  }
>;

/** Local voice (Option A) — STT/TTS run launcher-side via the ONNX sidecar. */
export interface VoiceStatus {
  state: 'idle' | 'provisioning' | 'starting' | 'ready' | 'error';
  stt: boolean;
  tts: boolean;
  sampleRate: number | null;
  error?: string;
}

type VoiceIpcEvents = Namespaced<
  'voice',
  {
    'get-status': () => VoiceStatus;
    /** Ensure the venv is provisioned and the sidecar is running. */
    start: () => VoiceStatus;
    /** PCM16LE mono base64 in → recognized text out. */
    transcribe: (pcmBase64: string, sampleRate: number) => string;
    /** Synthesize `text`; audio streams back via the `voice:audio` renderer event keyed by `streamId`. */
    speak: (streamId: string, text: string, voice?: string) => void;
    /**
     * Import a voice-clone sample for a persona: writes the audio, precomputes
     * the mimi embedding once, and returns the stored wav + `.npy` paths. The
     * `.npy` path goes into the persona's `voice.embeddingFile`.
     */
    'import-sample': (
      personaId: string,
      filename: string,
      dataBase64: string,
    ) => { file: string; embeddingFile: string };
  }
>;

/**
 * Unified agent process API. Main process handles these events, renderer process invokes them.
 * All operations are keyed by a processId — "chat" for the chat tab, CodeTabId for code tabs.
 */
type AgentProcessIpcEvents = Namespaced<
  'agent-process',
  {
    start: (processId: string, arg: AgentProcessStartOptions) => void;
    stop: (processId: string) => void;
    rebuild: (processId: string, arg: AgentProcessStartOptions) => void;
    resize: (processId: string, cols: number, rows: number) => void;
    'get-status': (processId: string) => WithTimestamp<AgentProcessStatus>;
    /**
     * Freeze the sandbox container via ``docker pause``. Returns an
     * envelope that distinguishes "ok" from "backend doesn't support
     * pause" so callers can decide between updating UI state, falling
     * through to stop/shutdown, or surfacing an error.
     */
    pause: (processId: string) => SandboxPauseResult;
    /** Thaw a previously-paused container. Same envelope shape as ``pause``. */
    unpause: (processId: string) => SandboxPauseResult;
    /**
     * Reset the sandbox's idle timer. Fire-and-forget; used by the
     * renderer to signal "user is engaging with this sandbox surface"
     * (chat scroll, code tab focus, etc.) so the watcher doesn't pause
     * during continuous interaction.
     */
    'notify-activity': (processId: string) => void;
    /**
     * Switch a running agent's sandbox to a different profile **in place** —
     * the `omni serve` process and its WebSocket stay up, so the conversation
     * never drops. Calls the `sandbox.switch` server function; on success the
     * main process updates this agent's `services`/`containerId` (the in-sandbox
     * service panes reload to the new URLs). Returns `{ok:false}` for profiles
     * that can't switch in place (e.g. `host` / a missing profile file), so the
     * caller can fall back to a stop+relaunch.
     */
    'switch-sandbox': (processId: string, profileName: string) => SandboxSwitchResult;
  }
>;

/** Result envelope returned by ``agent-process:pause`` / ``:unpause``.
 *  Mirrors the omni-code server-function schema. */
export type SandboxPauseResult = {
  ok: boolean;
  supported: boolean;
  paused?: boolean;
  reason?: string;
  /** Raw server-function result, when a caller needs fields beyond the envelope. */
  data?: Record<string, unknown>;
};

/** Result of an in-place `sandbox.switch`. */
export type SandboxSwitchResult = {
  ok: boolean;
  /** New profile name once switched (display label). */
  profile?: string;
  /** New backend client type (`docker` / `aci` / …). */
  backend?: string;
  /** New container id (docker/aci); absent for unix_local. */
  containerId?: string;
  /** New in-sandbox service URLs (code_server / vnc / …). */
  services?: Record<string, string>;
  /** Failure detail; present when `ok` is false. */
  reason?: string;
  /**
   * When `ok` is false: whether the caller should fall back to a full
   * stop+relaunch. True for "can't switch in place" (host/missing profile) and
   * for a `lost` sandbox; false when omni-code rolled back to the previous
   * profile (the session is still alive — relaunching would be wrong).
   */
  fallback?: boolean;
  /**
   * How a failed switch ended on the omni-code side: `rolled_back` (previous
   * profile restored, session live) or `lost` (sandbox gone, must relaunch).
   */
  recovered?: 'rolled_back' | 'lost';
};

type SnapshotIpcEvents = Namespaced<
  'snapshot',
  {
    /**
     * Cascade-delete the snapshot tar for *sessionId*. Called by the
     * renderer when a code tab is removed — the tab is gone for good,
     * its workspace pickle is dead weight. Idempotent (missing file is
     * not an error).
     */
    delete: (sessionId: string) => void;
  }
>;

/**
 * Utils API. Main process handles these events, renderer process invokes them.
 */
type UtilIpcEvents = Namespaced<
  'util',
  {
    'select-directory': (path?: string) => string | null;
    'select-file': (path?: string, filters?: Array<{ name: string; extensions: string[] }>) => string | null;
    'get-home-directory': () => string;
    'get-is-directory': (path: string) => boolean;
    'get-is-file': (path: string) => boolean;
    'get-path-exists': (path: string) => boolean;
    'get-os': () => OperatingSystem;
    'get-default-install-dir': () => string;
    'get-default-workspace-dir': () => string;
    'ensure-directory': (path: string) => boolean;
    'open-directory': (path: string) => string;
    /** Open a URL in the user's default browser via Electron `shell.openExternal`. */
    'open-external': (url: string) => void;
    'get-launcher-version': () => string;
    'get-omni-runtime-info': () => OmniRuntimeInfo;
    'check-url': (url: string) => boolean;
    'check-ws': (url: string) => boolean;
    'install-cli-to-path': () => { success: true; symlinkPath: string } | { success: false; error: string };
    'get-cli-in-path-status': () => { installed: boolean; symlinkPath: string };
    'check-models-configured': () => boolean;
    'test-model-connection': (modelRef?: string) => { success: boolean; output: string };
    /** Live merged model list from `omni model list --json` (includes discovered models). */
    'list-models': () => RuntimeModelList;
    'list-directory': (path: string) => { name: string; path: string; isDirectory: boolean }[];
    'rebuild-sandbox-image': () => { success: boolean; error?: string };
  }
>;

/**
 * Terminal API. Main process handles these events, renderer process invokes them.
 */
type TerminalIpcEvents = Namespaced<
  'terminal',
  {
    create: (tabId: string) => string;
    list: (tabId: string) => string[];
    write: (id: string, data: string) => void;
    resize: (id: string, cols: number, rows: number) => void;
    dispose: (id: string) => void;
    'dispose-all-for-tab': (tabId: string) => void;
  }
>;

/**
 * Config file I/O API. Main process handles these events, renderer process invokes them.
 */
type ConfigIpcEvents = Namespaced<
  'config',
  {
    'get-omni-config-dir': () => string;
    'get-env-file-path': () => string;
    'read-json-file': (path: string) => unknown | null;
    'write-json-file': (path: string, data: unknown) => void;
    'read-text-file': (path: string) => string | null;
    'write-text-file': (path: string, content: string) => void;
  }
>;

/**
 * ChatGPT (Codex) OAuth API. Main runs the browser PKCE flow and writes tokens
 * to the omni-code config dir; the renderer drives sign-in from Settings.
 */
type CodexIpcEvents = Namespaced<
  'codex',
  {
    /** Open the consent page, await the loopback callback, persist tokens.
     *  Electron-only: requires browser open + loopback :1455. */
    login: () => CodexAuthStatus;
    /** Device-flow sign-in (server/headless). Surfaces user code + URL via
     *  `codex:device-code` then polls until authorized. Works everywhere. */
    link: () => CodexAuthStatus;
    /** Remove the stored tokens. */
    logout: () => void;
    /** Current sign-in status, read from the token store. */
    status: () => CodexAuthStatus;
  }
>;

export type CodexAuthStatus = { signedIn: boolean; accountId?: string };

/** Device-flow code surface for the renderer to display while `codex:link` polls. */
export type CodexDeviceCode = { userCode: string; verificationUri: string };

/**
 * Cloud-link API. ``cloud:link`` opens the AAD device-code flow against the
 * launcher discovered via *url*, surfaces the user code through
 * ``cloud:device-code``, polls until approved, then persists the tokens +
 * the ``cloudMode`` flag in the store. The renderer is expected to reload
 * after a successful link so the transport switches to the cloud variant
 * at boot. ``cloud:unlink`` clears both. ``cloud:get-access-token`` is the
 * renderer's hook for fetching a fresh Bearer (refreshes via the stored
 * refresh token when near-expiry).
 */
type CloudIpcEvents = Namespaced<
  'cloud',
  {
    status: () => CloudStatus;
    link: (url: string) => CloudStatus;
    unlink: () => void;
    'get-access-token': () => string;
    /**
     * Fetch a fresh WS auth token from the linked cloud's ``/api/ws-token``.
     * Runs in main so the request escapes the renderer's CORS sandbox — the
     * Bearer header would otherwise trigger a CORS preflight that EasyAuth's
     * 302-to-AAD-login can't satisfy. Returns the opaque token the renderer
     * passes in the WebSocket upgrade URL.
     */
    'get-ws-token': () => string;
    /**
     * Local Electron's persisted machine identity (id + editable label +
     * platform). Used by the renderer's Settings → Cloud card to render the
     * "this is what the cloud sees you as" chip and to compare against the
     * cloud-side machines list to mark the calling row as `isSelf`.
     */
    'get-machine-identity': () => MachineIdentity;
    /**
     * Rename the local Electron's machine label. Persisted to
     * `<configDir>/machine.json` and (when cloud-linked) replayed to the cloud
     * via `machine:register` so the new label flows through.
     */
    'set-machine-label': (label: string) => MachineIdentity;
  }
>;

export type CloudStatus =
  | { connected: false }
  | {
      connected: true;
      url: string;
      tenantId: string;
      clientId: string;
      account: CloudAccount;
    };

/** Stable identity persisted in `<configDir>/machine.json`. */
export type MachineIdentity = {
  machineId: string;
  label: string;
  platform: string;
};

/**
 * Per-(principal) summary of a machine the cloud has seen. Used by the
 * Settings → Machines card and the SandboxPicker. `online` reflects whether
 * the cloud currently holds a live WS for that id; `isSelf` is `true` when
 * `machineId` matches the calling Electron's own identity.
 */
export type MachineSummary = {
  machineId: string;
  label: string;
  platform: string;
  online: boolean;
  isSelf: boolean;
  registeredAt: string;
  lastSeenAt: string;
};

/**
 * Per-principal machine registry — the cloud-side view of every Electron the
 * user has signed in from. Powers the SandboxPicker's "My computers" group
 * and the Settings → Machines card. No-op in single-user/local mode (returns
 * an empty list).
 *
 * `register` is invoked by the cloud-linked Electron over its existing WS at
 * boot; the cloud upserts the row scoped to the authenticated principal.
 * Removing a machine is explicit and severs its right to receive reverse-RPC
 * dispatches even if it later reconnects with the same id.
 */
type MachineIpcEvents = Namespaced<
  'machine',
  {
    register: (info: MachineIdentity) => { accepted: boolean };
    list: () => MachineSummary[];
    rename: (machineId: string, label: string) => MachineSummary[];
    remove: (machineId: string) => MachineSummary[];
  }
>;

/**
 * Renderer→main bridge for cloud reverse-RPC dispatch. The renderer owns the
 * cloud WS (in cloud-linked Electron) but compute lives in main; when the
 * cloud sends a `reverse-invoke`, the renderer forwards it through this one
 * channel and main resolves it against a per-channel registry.
 *
 * NOT user-callable — internal plumbing. Carries arbitrary (channel, args).
 */
type ReverseRpcIpcEvents = {
  'reverse-rpc:dispatch': (channel: string, args: unknown[]) => unknown;
  /**
   * Laptop → cloud: a WS frame inbound from the local omni-serve that the
   * cloud should forward to the renderer end of the tunnel. The cloud's
   * local-tunnel-proxy registers a per-tunnel routing entry keyed by
   * `tunnelId` and pipes the bytes onto the awaiting client WebSocket.
   *
   * Sent via `localEmitter.invoke` from renderer→main path: main pushes a
   * `tunnel:emit-incoming` event the renderer translates into this WS-invoke.
   * Returns `void` (fire-and-forget; we ignore the ack).
   */
  'tunnel:incoming': (event: { tunnelId: string; dataBase64: string; binary: boolean; close?: boolean }) => void;
};

/** Device-code payload for the renderer to display while `cloud:link` polls. */
export type CloudDeviceCode = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
};

/**
 * Typed agent-config API. Replaces the path-based `config:*` file I/O for the
 * four Settings configs whose source of truth is the (per-tenant, in cloud)
 * store rather than a file: model providers, MCP servers, network policy, and
 * `.env`. The backend persists them as store keys and re-materializes the
 * agent's on-disk config; the renderer never names a file path.
 */
type SettingsConfigIpcEvents = Namespaced<
  'settings',
  {
    'get-models-config': () => ModelsConfig;
    'set-models-config': (config: ModelsConfig) => void;
    'get-mcp-config': () => McpConfig;
    'set-mcp-config': (config: McpConfig) => void;
    'get-network-config': () => NetworkConfig;
    'set-network-config': (config: NetworkConfig) => void;
    'get-env': () => string;
    'set-env': (content: string) => void;
  }
>;

/** Payload for creating/replacing a git credential. The token is sent up once
 *  and never returned — handlers persist it to the `SecretStore` and echo back
 *  metadata only. */
export type GitCredentialInput = {
  host: string;
  username: string;
  /** The PAT / token. Write-only: never round-trips back to the renderer. */
  token: string;
  label?: string;
};

/**
 * Git credential management. Write-only by design: `set` accepts a plaintext
 * token but every channel returns metadata (`GitCredential[]`) only, so the
 * token never re-enters the renderer or the `store:changed` snapshot. Host-
 * scoped — `set` upserts by host (one credential per host).
 */
type GitCredentialIpcEvents = Namespaced<
  'git-cred',
  {
    list: () => GitCredential[];
    set: (input: GitCredentialInput) => GitCredential[];
    delete: (id: string) => GitCredential[];
  }
>;

/** Team role within a team (cloud/teams mode). */
export type TeamRole = 'owner' | 'admin' | 'member';

/** A team the current user belongs to, with their role. */
export type TeamSummary = {
  id: string;
  label: string;
  kind: 'personal' | 'shared';
  role: TeamRole;
};

/** A member of a team (admin views). */
export type TeamMember = {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: TeamRole;
};

/** A pending invitation to a team. */
export type TeamInvitation = {
  id: string;
  email: string;
  role: 'admin' | 'member';
  token: string;
};

/**
 * Teams control plane (cloud only). Membership reads are scoped to the caller;
 * mutations are role-gated server-side. Switching the active team is a
 * client-side reconnect with `?team=<id>`, not a channel here. No-op in
 * single-user/local mode (returns empty / the implicit personal team).
 */
type TeamIpcEvents = Namespaced<
  'team',
  {
    list: () => TeamSummary[];
    'get-my-role': () => TeamRole | null;
    /** The caller's principal id in teams/cloud mode; null in single-user/local (drives "my work" filters). */
    whoami: () => string | null;
    create: (label: string) => TeamSummary[];
    /** Leave the active team. Owners must transfer ownership first. */
    leave: () => TeamSummary[];
    rename: (label: string) => TeamSummary[];
    /** Delete the active team (owner only; non-personal, no projects). */
    delete: () => TeamSummary[];
    'transfer-ownership': (userId: string) => TeamMember[];
    invite: (email: string, role: 'admin' | 'member') => TeamInvitation[];
    'accept-invite': (token: string) => TeamSummary[];
    'revoke-invite': (id: string) => TeamInvitation[];
    'list-members': () => TeamMember[];
    'remove-member': (userId: string) => TeamMember[];
    'set-role': (userId: string, role: TeamRole) => TeamMember[];
    'list-invites': () => TeamInvitation[];
  }
>;

/** Which parts of the team-base agent config are currently set. */
export type TeamDefaultsStatus = {
  hasModels: boolean;
  hasMcp: boolean;
  hasEnv: boolean;
  hasNetwork: boolean;
};

/**
 * Team-base (shared) agent config editing. Admin-gated server-side.
 * `publish-from-mine` adopts the caller's effective models/mcp/env/network as the
 * team default for everyone; `clear` removes the team base (members fall back to
 * their own overlay). No-op (all false) in single-user/local mode.
 */
type TeamSettingsIpcEvents = Namespaced<
  'team-settings',
  {
    status: () => TeamDefaultsStatus;
    'publish-from-mine': () => TeamDefaultsStatus;
    clear: () => TeamDefaultsStatus;
  }
>;

/**
 * GitHub account linking. `link` runs the OAuth device flow (emitting
 * `github:device-code` to the renderer with the user code mid-flow), stores the
 * token as the `github.com` credential, and saves profile metadata. Discovery
 * (`list-owners` / `search-repos`) reads that token in the main process; it
 * never crosses to the renderer.
 */
type GithubIpcEvents = Namespaced<
  'github',
  {
    link: () => GithubStatus;
    status: () => GithubStatus;
    unlink: () => void;
    /** Owners to scope discovery by: the linked user plus their orgs. */
    'list-owners': () => GithubOwner[];
    /** Server-side repo search scoped to one owner (empty query → recent). */
    'search-repos': (query: GithubRepoQuery) => RemoteRepo[];
  }
>;

/**
 * Azure DevOps discovery, authenticated by the stored `dev.azure.com` PAT
 * credential (no separate OAuth — the credential is the link). Org-scoped: the
 * user supplies the org (typed in the picker), and `list-repos` lists every
 * repo across that org's projects, filtered by `query`.
 */
type AzureIpcEvents = Namespaced<
  'azure',
  {
    /** Repos in an org across its projects, name-filtered by `query`. */
    'list-repos': (input: { org: string; query: string }) => RemoteRepo[];
  }
>;

/**
 * How a skill was installed. Drives the source line shown in the UI and
 * determines whether the skill can be uninstalled by the user.
 */
export type SkillSource =
  | { kind: 'local' }
  | { kind: 'file'; filename: string }
  | { kind: 'marketplace'; repo: string; plugin: string; ref: string };

/**
 * One entry in a `.claude-plugin/marketplace.json` plugins[] array.
 * Each plugin is a curated bundle of skill folders within the same repo.
 */
export type MarketplacePlugin = {
  name: string;
  description: string;
  /** Relative root that `skills[]` paths are resolved against. */
  source: string;
  strict?: boolean;
  /** Directory paths (relative to `source`) that contain a SKILL.md. */
  skills: string[];
};

/**
 * Shape of a `.claude-plugin/marketplace.json` file as published by
 * Anthropic's skills repo and other Claude Code plugin marketplaces.
 */
export type MarketplaceApp = {
  id: string;
  label: string;
  icon: string;
  url: string;
  /** When true, install the app as column-scoped (visible in each session's dock). */
  columnScoped?: boolean;
};

export type MarketplaceManifest = {
  name: string;
  owner?: { name?: string; email?: string };
  metadata?: { description?: string; version?: string };
  plugins: MarketplacePlugin[];
  apps?: MarketplaceApp[];
};

/**
 * Persisted record of a marketplace bundle install. Keyed by `${repo}:${plugin}`
 * in `StoreData.installedBundles`. Used to diff against live manifests when
 * checking for updates and to reap skills that the upstream removed.
 */
export type InstalledBundle = {
  repo: string;
  plugin: string;
  /** Git ref the bundle was installed from (defaults to `main`). */
  ref: string;
  /** `metadata.version` from the manifest at install time, if any. */
  version?: string;
  /** SKILL.md `name` of every skill that was installed as part of this bundle. */
  skillNames: string[];
  installedAt: number;
};

export type BundleUpdateStatus = 'up-to-date' | 'update-available' | 'unreachable';

/**
 * Per-bundle update report returned by `skills:check-bundle-updates`. The UI
 * uses this to decide whether to show an "Update" button and what changed.
 */
export type BundleUpdateInfo = {
  bundleKey: string;
  repo: string;
  plugin: string;
  status: BundleUpdateStatus;
  installedVersion?: string;
  /** Manifest version live in the upstream repo. */
  liveVersion?: string;
  /** Skill names present upstream but not in the installed record. */
  addedSkills: string[];
  /** Skill names installed locally but no longer in the upstream manifest. */
  removedSkills: string[];
  /** Reason the manifest could not be fetched (when `status === 'unreachable'`). */
  error?: string;
};

/**
 * A discovered skill entry returned by the skills:list IPC handler.
 */
export type SkillEntry = {
  /** Directory name (must match `name` in SKILL.md frontmatter). */
  name: string;
  /** Human-readable description from SKILL.md frontmatter. */
  description: string;
  /** Absolute path to the skill directory. */
  path: string;
  /** Whether this skill is enabled for agent sessions. */
  enabled: boolean;
  /** How the skill was installed. */
  source: SkillSource;
  /** Skill version from frontmatter (optional). */
  version?: string;
  /** Skill author from frontmatter (optional). */
  author?: string;
  /** License identifier from frontmatter (optional). */
  license?: string;
  /** Environment/dependency requirements from frontmatter (optional). */
  compatibility?: string;
};

/**
 * Skills management API. Main process handles these events, renderer process invokes them.
 */
type SkillsIpcEvents = Namespaced<
  'skills',
  {
    list: () => SkillEntry[];
    install: (filePath: string) => SkillEntry;
    uninstall: (name: string) => void;
    'set-enabled': (name: string, enabled: boolean) => void;
    /** Download a marketplace.json from a github repo and parse it. */
    'fetch-marketplace': (repo: string) => MarketplaceManifest;
    /** Install every skill in the named plugin from the given repo. */
    'install-marketplace-plugin': (repo: string, pluginName: string) => SkillEntry[];
    /**
     * Re-fetch a previously installed bundle, install added/changed skills,
     * and remove skills that the upstream no longer ships. Bumps the stored
     * bundle record's version + skillNames + installedAt on success.
     */
    'update-marketplace-plugin': (repo: string, pluginName: string) => SkillEntry[];
    /** Probe upstream manifests for every installed bundle and report diffs. */
    'check-bundle-updates': () => BundleUpdateInfo[];
  }
>;

/**
 * Project & Ticket API. Main process handles these events, renderer process invokes them.
 */
type ProjectIpcEvents = Namespaced<
  'project',
  {
    'add-project': (project: Omit<Project, 'id' | 'createdAt'>) => Project;
    'update-project': (id: ProjectId, patch: Partial<Omit<Project, 'id' | 'createdAt'>>) => void;
    'remove-project': (id: ProjectId) => void;
    /** Resolved project directory — `Projects/<slug>/` or the default workspace root for Personal. Null if the project is unknown. */
    'get-dir': (projectId: ProjectId) => string | null;
    'check-git-repo': (workspaceDir: string) => GitRepoInfo;
    'add-ticket': (ticket: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'columnId'>) => Ticket;
    'update-ticket': (id: TicketId, patch: Partial<Omit<Ticket, 'id' | 'projectId' | 'createdAt'>>) => void;
    'remove-ticket': (id: TicketId) => void;
    'get-tickets': (projectId: ProjectId) => Ticket[];
    'get-ticket-workspace': (ticketId: TicketId) => string;
    'get-tasks': () => Task[];
    'get-next-ticket': (projectId: ProjectId) => Ticket | null;
    'move-ticket-to-column': (ticketId: TicketId, columnId: ColumnId) => void;
    'get-pipeline': (projectId: ProjectId) => Pipeline;
    'list-artifacts': (ticketId: TicketId, dirPath?: string) => ArtifactFileEntry[];
    'read-artifact': (ticketId: TicketId, relativePath: string) => ArtifactFileContent;
    'open-artifact-external': (ticketId: TicketId, relativePath: string) => void;
    /**
     * Diff one source's container subdir vs its ``omni/seed`` baseline.
     * ``sourceId`` is required: cross-source diffs aren't a thing — each
     * source has its own git repo inside the container. The renderer
     * iterates ``project.sources`` and calls this per source.
     */
    'get-files-changed': (ticketId: TicketId, sourceId: string) => DiffResponse;
    'get-code-tab-files-changed': (tabId: CodeTabId, sourceId: string) => DiffResponse;
    'apply-code-tab-source-changes': (tabId: CodeTabId, sourceId: string) => PrMergeResult;
    /** Detect an open PR for one source's branch in a code tab's container. Null when none. */
    'detect-code-tab-pull-request': (tabId: CodeTabId, sourceId: string) => ContainerPullRequest | null;
    /** Detect open PRs across all of a code tab's sources (deck banner, multi-source). */
    'detect-code-tab-pull-requests': (tabId: CodeTabId) => ContainerPullRequest[];
    /** Detect open PRs for the singleton chat session's workspace (0 or 1). */
    'detect-chat-pull-requests': () => ContainerPullRequest[];
    // Supervisor operations
    'ensure-supervisor-infra': (ticketId: TicketId) => void;
    'start-supervisor': (ticketId: TicketId, profileName?: string) => void;
    'stop-supervisor': (ticketId: TicketId) => void;
    'send-supervisor-message': (ticketId: TicketId, message: string) => void;
    'reset-supervisor-session': (ticketId: TicketId) => void;
    'resolve-ticket': (ticketId: TicketId, resolution: TicketResolution) => void;
    /** Assign (string principal id) or unassign (null) a ticket. Team ownership is unaffected; any member may call. */
    'assign-ticket': (ticketId: TicketId, assignee: string | null) => void;
    /**
     * Retry the deferred cleanup for a completed ticket whose worktree was
     * dirty. Returns true when cleanup succeeded, false when the worktree
     * still has uncommitted changes (cleanupPending stays set).
     */
    'finalize-ticket-cleanup': (ticketId: TicketId) => boolean;
    /** Dry-run apply one source's container patch onto its host repo; reports conflicts. */
    'check-merge': (ticketId: TicketId, sourceId: string) => PrMergeCheck;
    /** Apply one source's container patch onto its host repo ("sync to host"). */
    'merge-ticket': (ticketId: TicketId, sourceId: string) => PrMergeResult;
    /**
     * Detect an open GitHub PR for one source's branch by running
     * ``gh pr view`` inside the running container. Null when there's no PR.
     */
    'detect-pull-request': (ticketId: TicketId, sourceId: string) => ContainerPullRequest | null;
    'set-auto-dispatch': (projectId: ProjectId, enabled: boolean) => void;
    'get-active-wip-tickets': () => Ticket[];
    // Context file operations (replaces project.brief)
    'read-context': (projectId: ProjectId) => string;
    'write-context': (projectId: ProjectId, content: string) => void;
    // Project file listing
    'list-project-files': (projectId: ProjectId) => ArtifactFileEntry[];
    'get-context-preview': (projectId: ProjectId) => string;
    'open-project-file': (projectId: ProjectId, relativePath: string) => void;
  }
>;

/**
 * Supervisor bridge. The Code column owns the session, the WebSocket, and the
 * run lifecycle. Main only orchestrates — decides *when* to submit a prompt
 * and reacts to forwarded events. No main-process session id; no prepare step;
 * no client-request round trip (tool calls are handled entirely in the
 * renderer's `buildClientToolHandler`).
 */
/**
 * Per-dispatch run intent. The orchestrator composes this from its own state
 * (autopilot mode, supervisor framing, retry context, etc.) and ships it with
 * the `bridge.run` dispatch. The column merges it onto its locally owned
 * variables. Fields here are the subset that need to differ between
 * orchestrator-driven and user-driven submits.
 */
export type RunOverrides = {
  /** Prepended to the column's existing additional_instructions. */
  additionalInstructions?: string;
  /** Approval policy override; replaces the column's default. */
  safeToolOverrides?: { safe_tool_names?: string[]; safe_tool_patterns?: string[] };
};

export type SupervisorBridgeRequest =
  | {
      /**
       * Make sure a Code tab exists for this ticket. Creates one if needed,
       * switches the layout to code. Resolves after the actor registers.
       */
      kind: 'ensure-column';
      ticketId: TicketId;
      workspaceDir?: string;
      profileName?: string;
    }
  | {
      /**
       * Start a run. Routes through the same handleSubmit path the user's
       * keyboard uses. `runOverrides` carries the orchestrator's intent for
       * THIS run (supervisor prompt to inject, approval policy) atomically
       * with the dispatch — the column merges these on top of its locally
       * owned variables (`client_tools`, `workspace_root`) without having to
       * read steady-state autopilot mode (which would race with the dispatch).
       *
       * For user-initiated submits, `runOverrides` is undefined and the
       * column derives variables from steady-state `ticket.autopilot`.
       */
      kind: 'run';
      ticketId: TicketId;
      prompt: string;
      runOverrides?: RunOverrides;
    }
  | {
      /**
       * Start an autopilot ``/goal`` loop on this ticket's session. The
       * agent-side ``goal`` server function (in omni-code) owns the loop:
       * it installs the periodic tick, drives continuation prompts, and
       * stops when the agent calls ``goal_complete`` or when the launcher
       * issues a ``goal-stop``. Launcher subscribes to ``goal-update``
       * events to mirror snapshot state into the ticket record.
       */
      kind: 'goal-start';
      ticketId: TicketId;
      prompt: string;
      maxTurns?: number;
      tickInterval?: number;
      runOverrides?: RunOverrides;
    }
  | {
      /** Cancel the running ``/goal`` loop on this ticket's session. */
      kind: 'goal-stop';
      ticketId: TicketId;
    }
  | { kind: 'send'; ticketId: TicketId; message: string }
  | { kind: 'stop'; ticketId: TicketId }
  | {
      /** Stop current run and mint a fresh session id on the column. */
      kind: 'reset';
      ticketId: TicketId;
    }
  | { kind: 'dispose'; ticketId: TicketId };

export type GoalSnapshotPayload = {
  goal: string;
  turn: number;
  max_turns: number;
  tick_interval?: number;
  last_reason: string | null;
  status: 'active' | 'completed' | 'cancelled';
  started_at: number;
  completion_reason: string | null;
};

export type SupervisorBridgeEvent =
  | { kind: 'run-started'; ticketId: TicketId; runId: string }
  | { kind: 'run-end'; ticketId: TicketId; reason: string }
  | {
      kind: 'message';
      ticketId: TicketId;
      content: string;
      role?: 'user' | 'assistant';
      toolName?: string;
    }
  | { kind: 'token-usage'; ticketId: TicketId; usage: TokenUsage }
  | { kind: 'disconnected'; ticketId: TicketId }
  | {
      /**
       * Forwarded ``ui.goal.update`` snapshot from the omniagents ``/goal``
       * loop. ``snapshot`` is null when no goal is set on the session
       * (terminal cleanup). The orchestrator maps this onto ticket phase.
       */
      kind: 'goal-update';
      ticketId: TicketId;
      snapshot: GoalSnapshotPayload | null;
    };

type SupervisorIpcEvents = Namespaced<
  'supervisor',
  {
    /** Renderer reports the result of a bridge request issued by main. */
    'dispatch-result': (requestId: string, ok: boolean, result?: { runId?: string }, error?: string) => void;
    /** Renderer forwards a sandbox run event so main's orchestrator can react. */
    event: (event: SupervisorBridgeEvent) => void;
  }
>;

/**
 * Platform API. Main process handles these events, renderer process invokes them.
 * Only functional in enterprise builds (OMNI_PLATFORM_URL set at build time).
 */
export type PlatformDashboard = {
  resource_id: number;
  name: string;
  dashboard_id: string;
  workspace_url: string;
  widget_count: number;
  embed_url: string;
};

type PlatformIpcEvents = Namespaced<
  'platform',
  {
    /** Returns true if this is an enterprise build with a baked-in platform URL. */
    'is-enterprise': () => boolean;
    /** Returns current auth state. */
    'get-auth': () => PlatformCredentials | null;
    /** Initiates device code flow. Returns user_code + verification_uri for user to open. */
    'sign-in': () => { userCode: string; verificationUri: string; message: string };
    /** Signs out — clears stored credentials. */
    'sign-out': () => void;
    /** Fetch entitled dashboards from platform policy. */
    'get-dashboards': () => PlatformDashboard[];
  }
>;

/**
 * Milestone API. Main process handles these events, renderer process invokes them.
 */
type MilestoneIpcEvents = Namespaced<
  'milestone',
  {
    'get-items': (projectId: ProjectId) => Milestone[];
    'add-item': (item: Omit<Milestone, 'id' | 'createdAt' | 'updatedAt'>) => Milestone;
    'update-item': (id: MilestoneId, patch: Partial<Omit<Milestone, 'id' | 'projectId' | 'createdAt'>>) => void;
    'remove-item': (id: MilestoneId) => void;
  }
>;

/**
 * Page API. Main process handles these events, renderer process invokes them.
 */
type PageIpcEvents = Namespaced<
  'page',
  {
    'get-items': (projectId: ProjectId) => Page[];
    /** All pages across all projects. Used by the global Inbox view. */
    'get-all': () => Page[];
    /** Create a new page. Optional `template` seeds the body with starter content. */
    'add-item': (
      item: Omit<Page, 'id' | 'createdAt' | 'updatedAt'>,
      template?: import('@/lib/page-templates').TemplateKey
    ) => Page;
    'update-item': (id: PageId, patch: Partial<Omit<Page, 'id' | 'projectId' | 'createdAt'>>) => void;
    'remove-item': (id: PageId) => void;
    'read-content': (pageId: PageId) => string;
    'write-content': (pageId: PageId, content: string) => void;
    reorder: (pageId: PageId, newParentId: PageId | null, newSortOrder: number) => void;
    /** Subscribe to external-edit notifications for a page's file. Returns the current on-disk content. */
    watch: (pageId: PageId) => { content: string } | null;
    /** Unsubscribe from external-edit notifications. */
    unwatch: (pageId: PageId) => void;
    /**
     * Resolve a notebook page to its on-disk `.py` absolute path and the
     * containing project directory (used as the cwd for the marimo extension
     * instance). Returns null if the page isn't a notebook.
     */
    'get-notebook-paths': (pageId: PageId) => { filePath: string; projectDir: string } | null;
    /**
     * Ensure the marimo glass CSS file exists for this notebook's project and
     * migrate the notebook's `marimo.App()` to reference it. Idempotent —
     * called by the renderer immediately before opening a notebook.
     */
    'prepare-notebook': (pageId: PageId, glassEnabled: boolean) => void;
    /**
     * Rewrite the marimo glass CSS file content for a project. Called when
     * the launcher's glass mode toggles. Caller reloads the marimo webview
     * afterwards to pick up the new CSS.
     */
    'set-notebook-glass': (projectDir: string, enabled: boolean) => void;
  }
>;

/**
 * One-shot migration notice IPC. The Task #18 pages-relocation migration
 * records its summary into the store on boot; the renderer reads it to
 * show a dismissible notice, then either acknowledges or runs cleanup
 * (which `rm -rf`s the legacy paths and clears the notice in one step).
 */
type MigrationIpcEvents = Namespaced<
  'migration',
  {
    /** Read the current notice state. Null = nothing to show. */
    'get-pages-state': () => PagesMigrationState | null;
    /** Mark the notice dismissed without touching legacy files. */
    'acknowledge-pages': () => void;
    /**
     * Delete the recorded legacy directories/files and clear the notice.
     * Returns the count actually removed (paths that no longer exist are
     * skipped silently). Idempotent.
     */
    'cleanup-legacy-pages': () => { removed: number };
  }
>;

/**
 * Inbox API. Renderer invokes, main handles. The inbox is a global capture
 * surface (items can be projectless) backed by electron-store. Its lifecycle
 * is GTD: new → shaped → promoted (to ticket/project) or deferred.
 */
type InboxIpcEvents = Namespaced<
  'inbox',
  {
    /** All inbox items including promoted tombstones. */
    'get-all': () => InboxItem[];
    /** Active view: status !== 'later' and not promoted. */
    'get-active': () => InboxItem[];
    /** Create a new item. Defaults status to 'new'. */
    add: (input: { title: string; note?: string; projectId?: ProjectId | null; attachments?: string[] }) => InboxItem;
    /** Patch basic fields. Status transitions use the dedicated verbs below. */
    update: (id: InboxItemId, patch: Partial<Pick<InboxItem, 'title' | 'note' | 'projectId' | 'attachments'>>) => void;
    /** Hard delete. Use sparingly — prefer defer/promote for audit trail. */
    remove: (id: InboxItemId) => void;
    /** Attach or overwrite shaping. Sets status to 'shaped' unless item is in 'later'. */
    shape: (id: InboxItemId, shaping: InboxShaping) => void;
    /** Move to 'later'. Stamps `laterAt`. */
    defer: (id: InboxItemId) => void;
    /**
     * Move out of 'later' back to 'new' (or 'shaped' if shaping is present).
     * Clears `laterAt`.
     */
    reactivate: (id: InboxItemId) => void;
    /**
     * Promote to a ticket. Requires projectId. Seeds the ticket's title,
     * description, and shaping from the inbox item. Stamps `promotedTo` on
     * the inbox item so it disappears from active views but stays as a
     * tombstone for undo/audit.
     */
    'promote-to-ticket': (
      id: InboxItemId,
      opts: { projectId: ProjectId; milestoneId?: MilestoneId; columnId?: ColumnId }
    ) => Ticket;
    /**
     * Promote to a new project. Seeds the project's label. Stamps
     * `promotedTo`.
     */
    'promote-to-project': (id: InboxItemId, opts: { label: string }) => Project;
    /** Manually trigger the expiry sweep. Returns number of items flipped to later. */
    sweep: () => number;
    /**
     * GC promoted tombstones older than 30d. Returns number removed.
     * Called on a schedule; exposed for manual triggering in tests/tools.
     */
    'gc-promoted': () => number;
  }
>;

// ---------------------------------------------------------------------------
// Workspace sync types
// ---------------------------------------------------------------------------

export type WorkspaceSyncState = 'stopped' | 'starting' | 'syncing' | 'watching' | 'error';

export type WorkspaceSyncStatus = {
  state: WorkspaceSyncState;
  /** Files uploaded since sync started. */
  filesUploaded: number;
  /** Files downloaded since sync started. */
  filesDownloaded: number;
  /** Timestamp of the last completed sync operation. */
  lastSyncAt: number | null;
  /** Human-readable error (only when state === 'error'). */
  error?: string;
  /** Progress of the current batch operation (if any). */
  progress?: {
    /** What we're doing right now. */
    phase: 'uploading' | 'downloading' | 'reconciling';
    /** Total files in the current batch. */
    totalFiles: number;
    /** Files completed so far. */
    completedFiles: number;
    /** Observed bytes per second (smoothed). */
    bytesPerSecond: number;
    /** Estimated seconds remaining (null if unknown). */
    etaSeconds: number | null;
    /** Timestamp when this batch started. */
    startedAt: number;
  };
};

/**
 * Extension API. Built-in (and eventually user-managed) external tools the
 * launcher orchestrates as local subprocesses. Marimo is the seed consumer.
 *
 * Instances are scoped to a working directory (typically a project folder)
 * and refcounted — multiple webview surfaces sharing the same cwd reuse a
 * single subprocess. See `src/main/extension-manager.ts` for the lifecycle.
 */
type ExtensionIpcEvents = Namespaced<
  'extension',
  {
    'list-descriptors': () => ExtensionDescriptor[];
    'set-enabled': (id: string, enabled: boolean) => void;
    'get-instance-status': (id: string, cwd: string) => ExtensionInstanceState;
    'ensure-instance': (id: string, cwd: string) => ExtensionEnsureResult;
    'release-instance': (id: string, cwd: string) => void;
    'get-logs': (id: string, cwd: string) => string;
  }
>;

/**
 * Workspace sync IPC events. Renderer invokes, main handles.
 */
type WorkspaceSyncIpcEvents = Namespaced<
  'workspace-sync',
  {
    start: (projectId: string, workspaceDir: string) => void;
    stop: (projectId: string) => void;
    'get-status': (projectId: string) => WorkspaceSyncStatus;
    'get-share-name': (projectId: string) => string | null;
  }
>;

/**
 * App-control events. Renderer registers every live `<Webview>` with main so
 * agents can drive them via client tools (list_apps, app_click, app_snapshot,
 * ...). See `src/shared/app-control-types.ts` for payload shapes.
 */
type AppControlIpcEvents = Namespaced<
  'app',
  {
    register: (payload: import('@/shared/app-control-types').AppRegistrationPayload) => void;
    update: (
      handleId: import('@/shared/app-control-types').AppHandleId,
      patch: Partial<import('@/shared/app-control-types').AppRegistrationPayload>
    ) => void;
    unregister: (handleId: import('@/shared/app-control-types').AppHandleId) => void;
    list: () => import('@/shared/app-control-types').LiveAppSnapshot[];
    navigate: (handleId: import('@/shared/app-control-types').AppHandleId, url: string) => void;
    reload: (handleId: import('@/shared/app-control-types').AppHandleId) => void;
    back: (handleId: import('@/shared/app-control-types').AppHandleId) => void;
    forward: (handleId: import('@/shared/app-control-types').AppHandleId) => void;
    eval: (handleId: import('@/shared/app-control-types').AppHandleId, code: string) => unknown;
    screenshot: (
      handleId: import('@/shared/app-control-types').AppHandleId,
      options?: import('@/shared/app-control-types').AppScreenshotOptions
    ) => string;
    console: (
      handleId: import('@/shared/app-control-types').AppHandleId,
      options?: { minLevel?: import('@/shared/app-control-types').AppConsoleLevel; clear?: boolean }
    ) => import('@/shared/app-control-types').AppConsoleEntry[];
    snapshot: (
      handleId: import('@/shared/app-control-types').AppHandleId
    ) => import('@/shared/app-control-types').AxNode;
    'snapshot-diff': (
      handleId: import('@/shared/app-control-types').AppHandleId
    ) => import('@/main/app-control-cdp').SnapshotDiff;
    click: (
      handleId: import('@/shared/app-control-types').AppHandleId,
      ref: string,
      options?: { button?: import('@/shared/app-control-types').AppClickButton }
    ) => void;
    fill: (handleId: import('@/shared/app-control-types').AppHandleId, ref: string, text: string) => void;
    type: (handleId: import('@/shared/app-control-types').AppHandleId, text: string) => void;
    press: (handleId: import('@/shared/app-control-types').AppHandleId, key: string) => void;
    scroll: (
      handleId: import('@/shared/app-control-types').AppHandleId,
      options: { dx?: number; dy?: number; toTop?: boolean; toBottom?: boolean }
    ) => void;
    'inject-css': (handleId: import('@/shared/app-control-types').AppHandleId, css: string) => string;
    'remove-inserted-css': (handleId: import('@/shared/app-control-types').AppHandleId, key: string) => void;
    find: (
      handleId: import('@/shared/app-control-types').AppHandleId,
      query: string,
      options?: { caseSensitive?: boolean; forward?: boolean; findNext?: boolean }
    ) => { matches: number; activeOrdinal: number };
    'stop-find': (handleId: import('@/shared/app-control-types').AppHandleId) => void;
    'wait-for': (
      handleId: import('@/shared/app-control-types').AppHandleId,
      options: { selector?: string; urlIncludes?: string; networkIdle?: boolean; timeoutMs?: number }
    ) => { ok: true; matched: 'selector' | 'url' | 'networkIdle' };
    'scroll-to-ref': (handleId: import('@/shared/app-control-types').AppHandleId, ref: string) => void;
    'network-log': (
      handleId: import('@/shared/app-control-types').AppHandleId,
      options?: { limit?: number; since?: number; urlIncludes?: string; statusMin?: number; clear?: boolean }
    ) => import('@/main/app-control-cdp').NetworkLogEntry[];
    pdf: (
      handleId: import('@/shared/app-control-types').AppHandleId,
      options?: { artifactsSubdir?: string; landscape?: boolean; printBackground?: boolean }
    ) => string;
    'full-screenshot': (
      handleId: import('@/shared/app-control-types').AppHandleId,
      options?: import('@/shared/app-control-types').AppScreenshotOptions
    ) => string;
    'element-screenshot': (
      handleId: import('@/shared/app-control-types').AppHandleId,
      ref: string,
      options?: import('@/shared/app-control-types').AppScreenshotOptions
    ) => string;
    'set-viewport': (
      handleId: import('@/shared/app-control-types').AppHandleId,
      options: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean } | { clear: true }
    ) => void;
    'set-user-agent': (handleId: import('@/shared/app-control-types').AppHandleId, ua: string) => void;
    'set-zoom': (handleId: import('@/shared/app-control-types').AppHandleId, factor: number) => void;
    'cookies-get': (
      handleId: import('@/shared/app-control-types').AppHandleId,
      filter?: { url?: string; name?: string; domain?: string; path?: string }
    ) => unknown[];
    'cookies-set': (
      handleId: import('@/shared/app-control-types').AppHandleId,
      cookie: {
        url: string;
        name: string;
        value: string;
        domain?: string;
        path?: string;
        secure?: boolean;
        httpOnly?: boolean;
        expirationDate?: number;
        sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
      }
    ) => void;
    'cookies-clear': (
      handleId: import('@/shared/app-control-types').AppHandleId,
      filter?: { url?: string; name?: string }
    ) => number;
    'storage-get': (
      handleId: import('@/shared/app-control-types').AppHandleId,
      which: 'local' | 'session'
    ) => Record<string, string>;
    'storage-set': (
      handleId: import('@/shared/app-control-types').AppHandleId,
      which: 'local' | 'session',
      entries: Record<string, string>
    ) => void;
    'storage-clear': (handleId: import('@/shared/app-control-types').AppHandleId, which: 'local' | 'session') => void;
  }
>;

/**
 * Browser API. Owns tabs, history, bookmarks, and profiles. Renderer invokes,
 * main handles. State mutations broadcast `browser:state-changed` events so
 * every open surface re-renders from the same source of truth.
 */
type BrowserIpcEvents = Namespaced<
  'browser',
  {
    /** Full snapshot of the persisted browser state. Cheap — entire state lives in electron-store. */
    'get-state': () => {
      profiles: BrowserProfile[];
      tabsets: Record<BrowserTabsetId, BrowserTabset>;
      bookmarks: BrowserBookmark[];
    };
    /** Create a new profile. Partition is derived from id. */
    'profile-add': (input: { label: string; incognito?: boolean }) => BrowserProfile;
    'profile-remove': (id: BrowserProfileId) => void;
    /** Idempotent. Ensures a tabset exists and returns it; creates a blank tab on first call. */
    'tabset-ensure': (
      id: BrowserTabsetId,
      opts?: { profileId?: BrowserProfileId; initialUrl?: string }
    ) => BrowserTabset;
    'tabset-remove': (id: BrowserTabsetId) => void;
    /** Switch a tabset to a different profile; swaps its partition on remount. */
    'tabset-set-profile': (id: BrowserTabsetId, profileId: BrowserProfileId) => void;
    /** Create a new tab. If `activate` is true (default), also activates it. */
    'tab-create': (
      tabsetId: BrowserTabsetId,
      opts?: { url?: string; activate?: boolean; profileId?: BrowserProfileId }
    ) => BrowserTab;
    'tab-close': (tabsetId: BrowserTabsetId, tabId: BrowserTabId) => void;
    'tab-activate': (tabsetId: BrowserTabsetId, tabId: BrowserTabId) => void;
    'tab-navigate': (tabsetId: BrowserTabsetId, tabId: BrowserTabId, url: string) => void;
    'tab-update-meta': (
      tabsetId: BrowserTabsetId,
      tabId: BrowserTabId,
      patch: { title?: string; favicon?: string; url?: string }
    ) => void;
    'tab-reorder': (tabsetId: BrowserTabsetId, tabIds: BrowserTabId[]) => void;
    'tab-pin': (tabsetId: BrowserTabsetId, tabId: BrowserTabId, pinned: boolean) => void;
    'tab-duplicate': (tabsetId: BrowserTabsetId, tabId: BrowserTabId) => BrowserTab;
    /** Restore the most recently closed tab in this tabset (LIFO). */
    'tab-reopen': (tabsetId: BrowserTabsetId) => BrowserTab | null;
    /** Record a visit. Dedupes against the most recent entry for the same URL. */
    'history-record': (entry: { url: string; title?: string; profileId: BrowserProfileId }) => void;
    'history-list': (opts?: { query?: string; limit?: number; profileId?: BrowserProfileId }) => BrowserHistoryEntry[];
    'history-clear': (opts?: { profileId?: BrowserProfileId }) => void;
    'bookmark-add': (input: { url: string; title: string; folder?: string }) => BrowserBookmark;
    'bookmark-remove': (id: string) => void;
    /** Returns a ranked mix of history + bookmarks + a synthetic search entry. */
    suggest: (query: string, opts?: { limit?: number; profileId?: BrowserProfileId }) => BrowserSuggestion[];
    /** List in-memory downloads across every watched partition. Newest first. */
    'downloads-list': () => BrowserDownloadEntry[];
    'downloads-clear': () => number;
    'downloads-remove': (id: string) => void;
    /** Open a completed download with the OS default handler. */
    'downloads-open-file': (id: string) => string;
    /** Reveal a completed download in Finder / Explorer. */
    'downloads-show-in-folder': (id: string) => void;
    /**
     * Signal that a new webview with this partition is about to render, so
     * the main process attaches its `will-download` listener. Safe to call
     * repeatedly — idempotent per-session.
     */
    'downloads-watch-partition': (partition: string) => void;
    /** List all outstanding permission requests awaiting a decision. */
    'permissions-list': () => import('@/shared/permissions-types').PermissionRequest[];
    /** Allow or deny a pending permission request by id. */
    'permissions-decide': (id: string, allow: boolean) => void;
    /** Attach the permission handler to a new partition on first mount. */
    'permissions-watch-partition': (partition: string) => void;
  }
>;

/**
 * Download tracking — one entry per `DownloadItem` observed via
 * `session.will-download`. Lives in memory (not persisted), newest first.
 */
export type BrowserDownloadState = 'progressing' | 'interrupted' | 'paused' | 'completed' | 'cancelled';

export type BrowserDownloadEntry = {
  id: string;
  url: string;
  filename: string;
  savePath?: string;
  mimeType?: string;
  totalBytes: number;
  receivedBytes: number;
  state: BrowserDownloadState;
  startedAt: number;
  endedAt?: number;
  partition?: string;
};

/**
 * Intersection of all the events that the renderer can invoke and main process can handle.
 */
export type IpcEvents = MainProcessIpcEvents &
  OmniInstallProcessIpcEvents &
  VoiceIpcEvents &
  AgentProcessIpcEvents &
  SnapshotIpcEvents &
  UtilIpcEvents &
  TerminalIpcEvents &
  StoreIpcEvents &
  ConfigIpcEvents &
  CodexIpcEvents &
  CloudIpcEvents &
  MachineIpcEvents &
  ReverseRpcIpcEvents &
  SettingsConfigIpcEvents &
  GitCredentialIpcEvents &
  TeamIpcEvents &
  TeamSettingsIpcEvents &
  GithubIpcEvents &
  AzureIpcEvents &
  SkillsIpcEvents &
  ProjectIpcEvents &
  MilestoneIpcEvents &
  PageIpcEvents &
  InboxIpcEvents &
  MigrationIpcEvents &
  PlatformIpcEvents &
  ExtensionIpcEvents &
  WorkspaceSyncIpcEvents &
  AppControlIpcEvents &
  BrowserIpcEvents &
  SupervisorIpcEvents;

/**
 * Store events. Main process emits these events, renderer process listens to them.
 */
type StoreIpcRendererEvents = Namespaced<
  'store',
  {
    changed: [StoreData | undefined];
  }
>;

/**
 * Terminal events. Main process emits these events, renderer process listens to them.
 */
type TerminalIpcRendererEvents = Namespaced<
  'terminal',
  {
    output: [string, string, string];
    exited: [string, string, number];
  }
>;

/**
 * Main process events. Main process emits these events, renderer process listens to them.
 */
type MainProcessIpcRendererEvents = Namespaced<
  'main-process',
  {
    status: [WithTimestamp<MainProcessStatus>];
  }
>;

type OmniInstallProcessIpcRendererEvents = Namespaced<
  'omni-install-process',
  {
    status: [WithTimestamp<OmniInstallProcessStatus>];
    log: [WithTimestamp<LogEntry>];
    'raw-output': [string];
  }
>;

type VoiceIpcRendererEvents = Namespaced<
  'voice',
  {
    /** One streamed TTS chunk (PCM16LE base64) for the `speak` call `streamId`. */
    audio: [{ streamId: string; pcm: string; sampleRate: number }];
    /** Terminal marker for a `speak` stream. */
    'audio-end': [{ streamId: string }];
  }
>;

/**
 * Unified agent process events. Main process emits these, renderer listens.
 * All keyed by processId.
 */
type AgentProcessIpcRendererEvents = Namespaced<
  'agent-process',
  {
    status: [string, WithTimestamp<AgentProcessStatus>];
    'raw-output': [string, string];
  }
>;

/**
 * Dev events. Main process emits these events, renderer process listens to them.
 */
type DevIpcRendererEvents = Namespaced<
  'dev',
  {
    'console-log': [unknown];
  }
>;

/**
 * Toast notification level and payload pushed from main to renderer.
 */
export type ToastPayload = {
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  description?: string;
};

/**
 * Toast events. Main process emits these events, renderer process listens to them.
 */
type ToastIpcRendererEvents = Namespaced<
  'toast',
  {
    show: [ToastPayload];
  }
>;

/**
 * Project events. Main process emits these events, renderer process listens to them.
 */
type ProjectIpcRendererEvents = Namespaced<
  'project',
  {
    'task-status': [TaskId, WithTimestamp<AgentProcessStatus>];
    'task-session': [TaskId, string];
    phase: [TicketId, import('@/shared/ticket-phase').TicketPhase];
    'supervisor-message': [TicketId, SessionMessage];
    'token-usage': [TicketId, TokenUsage];
  }
>;

/**
 * Platform events. Main process emits these events, renderer process listens to them.
 */
/**
 * Page content events. Main process emits when a watched page file changes on
 * disk due to an external edit (e.g. the user edited a page in their IDE, or
 * an MCP client like Claude Desktop wrote into `<config>/pages/<projectId>/`).
 */
type PageIpcRendererEvents = Namespaced<
  'page',
  {
    'content-changed': [PageId, string];
    'content-deleted': [PageId];
  }
>;

type PlatformIpcRendererEvents = Namespaced<
  'platform',
  {
    /** Emitted when auth state changes (sign in / sign out / token refresh). */
    'auth-changed': [PlatformCredentials | null];
  }
>;

/**
 * Extension events. Main process emits these, renderer listens. Status
 * updates fire on every state transition (idle → starting → running → idle/error)
 * for a given (extensionId, cwd) instance.
 */
type ExtensionIpcRendererEvents = Namespaced<
  'extension',
  {
    'status-changed': [string, string, ExtensionInstanceState];
  }
>;

/**
 * Workspace sync events. Main process emits these, renderer listens.
 */
type WorkspaceSyncIpcRendererEvents = Namespaced<
  'workspace-sync',
  {
    'status-changed': [string, WorkspaceSyncStatus];
  }
>;

/**
 * Supervisor bridge — main → renderer. Main issues commands to the column
 * actor. Tool calls / approvals never round-trip through main; the column's
 * `buildClientToolHandler` handles them directly.
 */
type SupervisorIpcRendererEvents = Namespaced<
  'supervisor',
  {
    dispatch: [string, SupervisorBridgeRequest];
  }
>;

/**
 * Browser events. Main process emits a full-state snapshot whenever any
 * browser mutation lands — tabs, history, bookmarks, profiles. Renderers
 * simply replace their atom.
 */
type BrowserIpcRendererEvents = Namespaced<
  'browser',
  {
    'state-changed': [
      {
        profiles: BrowserProfile[];
        tabsets: Record<BrowserTabsetId, BrowserTabset>;
        bookmarks: BrowserBookmark[];
      },
    ];
    'downloads-changed': [BrowserDownloadEntry[]];
    'permissions-changed': [import('@/shared/permissions-types').PermissionRequest[]];
  }
>;

/**
 * Intersection of all the events emitted by main process that the renderer can listen to.
 */
/** Main→renderer: the device-flow user code to display while `github:link` polls. */
type GithubIpcRendererEvents = Namespaced<'github', { 'device-code': [GithubDeviceCode] }>;

/** Main→renderer: the device-flow user code to display while `codex:link` polls. */
type CodexIpcRendererEvents = Namespaced<'codex', { 'device-code': [CodexDeviceCode] }>;

/** Main→renderer: the AAD device-code to display while `cloud:link` polls. */
type CloudIpcRendererEvents = Namespaced<'cloud', { 'device-code': [CloudDeviceCode] }>;

/**
 * Main→renderer: pushed by the cloud whenever a principal's machine list
 * changes (registration, label edit, removal, online/offline). The renderer
 * mirrors it into a nanostore so the picker and Settings card refresh in
 * place without polling.
 */
type MachineIpcRendererEvents = Namespaced<'machine', { 'list-changed': [MachineSummary[]] }>;

/**
 * Main → renderer (cloud-linked Electron only): an inbound tunnel frame from
 * local omni-serve that the cloud expects on its `tunnel:incoming` WS
 * channel. The renderer's tunnel bridge re-emits it onto the cloud WS via
 * `emitter.invoke('tunnel:incoming', event)`. No-op outside cloud-linked
 * mode (the listener is never attached).
 */
type TunnelIpcRendererEvents = Namespaced<
  'tunnel',
  {
    'emit-incoming': [{ tunnelId: string; dataBase64: string; binary: boolean; close?: boolean }];
  }
>;

export type IpcRendererEvents = TerminalIpcRendererEvents &
  GithubIpcRendererEvents &
  CodexIpcRendererEvents &
  CloudIpcRendererEvents &
  MachineIpcRendererEvents &
  TunnelIpcRendererEvents &
  MainProcessIpcRendererEvents &
  OmniInstallProcessIpcRendererEvents &
  VoiceIpcRendererEvents &
  AgentProcessIpcRendererEvents &
  DevIpcRendererEvents &
  StoreIpcRendererEvents &
  ProjectIpcRendererEvents &
  PageIpcRendererEvents &
  ToastIpcRendererEvents &
  PlatformIpcRendererEvents &
  ExtensionIpcRendererEvents &
  WorkspaceSyncIpcRendererEvents &
  BrowserIpcRendererEvents &
  SupervisorIpcRendererEvents;

// #region Config file types

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type ModelEntry = {
  model: string;
  label?: string;
  realtime?: boolean;
  reasoning?: ReasoningEffort;
  max_input_tokens?: number;
  max_output_tokens?: number;
  api_key?: string;
  model_settings?: Record<string, unknown>;
};

/** One entry from `omni model list --json` — the live, merged runtime view. */
export type RuntimeModelEntry = {
  name: string;
  label?: string;
  provider?: string;
  realtime?: boolean;
  reasoning?: ReasoningEffort;
};

export type RuntimeModelList = {
  models: RuntimeModelEntry[];
  default: string | null;
  voice_default: string | null;
};

export type ProviderEntry = {
  // `openai-oauth` — ChatGPT (Codex) subscription auth. No `api_key`; the
  // runtime authenticates with stored OAuth tokens (see codex.json /
  // omni_code.codex_auth) and talks the Responses API to the Codex backend.
  type: 'openai' | 'azure' | 'openai-compatible' | 'litellm' | 'openai-oauth';
  api_key?: string;
  base_url?: string;
  api_version?: string;
  models: Record<string, ModelEntry>;
};

export type ModelsConfig = {
  version: 3;
  default: string | null;
  voice_default: string | null;
  providers: Record<string, ProviderEntry>;
};

export type McpServerEntry = {
  type?: 'stdio' | 'sse' | 'http' | 'streamable_http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

export type McpConfig = {
  mcpServers: Record<string, McpServerEntry>;
};

export type NetworkConfig = {
  enabled: boolean;
  presets: string[];
  allowlist: string[];
  denylist: string[];
  allow_private_ips: boolean;
  enable_socks5: boolean;
};

// #endregion
