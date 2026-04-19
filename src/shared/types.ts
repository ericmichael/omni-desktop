import type { Rectangle } from 'electron/main';
import type { Schema } from 'electron-store';

import type { CustomAppEntry } from '@/shared/app-registry';
import type {
  ExtensionDescriptor,
  ExtensionEnsureResult,
  ExtensionInstanceState,
} from '@/shared/extensions';

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
export type LayoutMode = 'chat' | 'code' | 'projects' | 'dashboards' | 'settings' | 'more' | 'gallery';
export type OmniTheme =
  | 'teams-light'
  | 'teams-dark'
  | 'default'
  | 'tokyo-night'
  | 'vscode-dark'
  | 'vscode-light'
  | 'utrgv';

export type SandboxVariant = 'standard' | 'work';
export type SandboxBackend = 'platform' | 'docker' | 'podman' | 'vm' | 'local' | 'none';

/**
 * A sandbox execution profile from platform policy.
 * Each Machine governed resource produces one of these.
 */
export type SandboxProfile = {
  resource_id: number;
  name: string;
  backend: SandboxBackend;
  variant?: string;
  image?: string;
  network_mode?: string;
  resource_limits?: {
    cpu?: string;
    memory?: string;
    max_duration_minutes?: number;
  };
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

export type StoreData = {
  workspaceDir?: string;
  sandboxBackend: SandboxBackend;
  /** Platform-provided sandbox profiles. Null = open-source mode (all local backends available). */
  sandboxProfiles: SandboxProfile[] | null;
  /** ID of the selected Machine governed resource (from sandboxProfiles). */
  selectedMachineId: number | null;
  launcherWindowProps?: WindowProps;
  appWindowProps?: WindowProps;
  optInToLauncherPrereleases: boolean;
  previewFeatures: boolean;

  layoutMode: LayoutMode;
  theme: OmniTheme;
  onboardingComplete: boolean;
  projects: Project[];
  milestones: Milestone[];
  pages: Page[];
  inboxItems: InboxItem[];
  tasks: Task[];
  tickets: Ticket[];
  /** Maximum active tickets across all projects (cognitive WIP limit). Default: 3. */
  wipLimit: number;
  /** Day of week for the weekly review prompt (0=Sun, 1=Mon, ..., 6=Sat). Default: 5 (Friday). */
  weeklyReviewDay: number;
  /** Timestamp (ms) of last completed weekly review. Null if never done. */
  lastWeeklyReviewAt: number | null;
  schemaVersion: number;
  chatSessionId: string | null;
  /** Which project is selected in the Chat tab. Null = no project context. */
  chatProjectId: ProjectId | null;
  codeTabs: CodeTab[];
  activeCodeTabId: CodeTabId | null;
  codeLayoutMode: CodeLayoutMode;
  /** Optional background image (data URL) rendered behind the Code Deck. */
  codeDeckBackground: string | null;
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

  /** User-added custom apps for the workspace dock. */
  customApps: CustomAppEntry[];

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
  sandboxBackend: {
    type: 'string',
    enum: ['platform', 'docker', 'podman', 'vm', 'local', 'none'],
    default: 'none',
  },
  sandboxProfiles: {
    type: ['array', 'null'],
    default: null,
  },
  selectedMachineId: {
    type: ['number', 'null'],
    default: null,
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

  layoutMode: {
    type: 'string',
    enum: ['chat', 'code', 'projects', 'dashboards', 'settings', 'more', 'gallery'],
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
  wipLimit: {
    type: 'number',
    default: 3,
  },
  weeklyReviewDay: {
    type: 'number',
    default: 5,
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
  chatProjectId: {
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
    enum: ['deck', 'focus'],
    default: 'deck',
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
        source: { type: ['object', 'null'] },
        createdAt: { type: 'number' },
        pipeline: { type: 'object' },
        sandbox: { type: ['object', 'null'] },
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
        createdAt: { type: 'number' },
        updatedAt: { type: 'number' },
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
      },
      required: [
        'id',
        'projectId',
        'title',
        'description',
        'priority',
        'blockedBy',
        'createdAt',
        'updatedAt',
      ],
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
 */
type ErrorStatus = {
  type: 'error';
  error: {
    message: string;
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

// Unified agent process data — superset of sandbox and local process data
export type AgentProcessData = {
  uiUrl: string;
  wsUrl?: string;
  sandboxUrl?: string;
  codeServerUrl?: string;
  noVncUrl?: string;
  containerId?: string;
  containerName?: string;
  port?: number;
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

export type CodeLayoutMode = 'deck' | 'focus';


export type CodeTab = {
  id: CodeTabId;
  projectId: ProjectId | null;
  ticketId?: TicketId;
  sessionId?: string;
  ticketTitle?: string;
  workspaceDir?: string;
  /** When set, this tab renders as a global app column (webview) instead of an agent session. */
  customAppId?: string;
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

// --- Sandbox config ---

/**
 * Per-project sandbox configuration. When set, supervisors run inside a Docker container
 * using the specified image or Dockerfile. When absent/null, the default sandbox is used.
 */
export type SandboxConfig = {
  /** Pre-built Docker image (e.g. "ubuntu:24.04"). */
  image?: string;
  /** Path to a Dockerfile (relative to workspace). */
  dockerfile?: string;
};

// --- Core entities ---

/** Credential reference for git-remote sources. Resolved at clone time by the platform. */
export type GitCredentialRef = { kind: 'platform-managed'; credentialId: string };

/**
 * Discriminated union describing where a project's code repo lives.
 * Optional — projects don't require a linked repo.
 * - `local`: directory on the user's machine (may or may not be a git repo — `gitDetected` is auto-set).
 * - `git-remote`: sandbox clones the repo; git is the persistence layer.
 */
export type ProjectSource =
  | { kind: 'local'; workspaceDir: string; gitDetected?: boolean }
  | { kind: 'git-remote'; repoUrl: string; defaultBranch?: string; credentials?: GitCredentialRef };

export type Project = {
  id: ProjectId;
  label: string;
  /** Filesystem-safe name derived from label, used for project folder path. */
  slug: string;
  /** True for the auto-created Personal project. Cannot be deleted. */
  isPersonal?: boolean;
  /** Optional repo link. Projects without a repo use their project folder as workspace. */
  source?: ProjectSource;
  createdAt: number;
  /** Pipeline configuration. If undefined, DEFAULT_PIPELINE is used. */
  pipeline?: Pipeline;
  /** When true, automatically dispatch tickets from backlog in priority order. */
  autoDispatch?: boolean;
  /** Per-project sandbox configuration. When absent/null, the default sandbox image is used. */
  sandbox?: SandboxConfig | null;
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
  createdAt: number;
  updatedAt: number;
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

  // Supervisor state
  /** Persistent supervisor session ID (survives across start_run calls). */
  supervisorSessionId?: string;
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
  /** History of supervisor runs on this ticket. */
  runs?: TicketRun[];
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

export type FileDiff = {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked';
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
    create: (cwd?: string) => string;
    list: () => string[];
    write: (id: string, data: string) => void;
    resize: (id: string, cols: number, rows: number) => void;
    dispose: (id: string) => void;
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
    'add-ticket': (
      ticket: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'columnId'>
    ) => Ticket;
    'update-ticket': (id: TicketId, patch: Partial<Omit<Ticket, 'id' | 'projectId' | 'createdAt'>>) => void;
    'remove-ticket': (id: TicketId) => void;
    'get-tickets': (projectId: ProjectId) => Ticket[];
    'get-ticket-workspace': (ticketId: TicketId) => string;
    'get-tasks': () => Task[];
    'get-next-ticket': (projectId: ProjectId) => Ticket | null;
    'move-ticket-to-column': (ticketId: TicketId, columnId: ColumnId) => void;
    'get-pipeline': (projectId: ProjectId) => Pipeline;
    'get-session-history': (sessionId: string) => SessionMessage[];
    'list-artifacts': (ticketId: TicketId, dirPath?: string) => ArtifactFileEntry[];
    'read-artifact': (ticketId: TicketId, relativePath: string) => ArtifactFileContent;
    'open-artifact-external': (ticketId: TicketId, relativePath: string) => void;
    'get-files-changed': (ticketId: TicketId) => DiffResponse;
    // Supervisor operations
    'ensure-supervisor-infra': (ticketId: TicketId) => void;
    'start-supervisor': (ticketId: TicketId) => void;
    'stop-supervisor': (ticketId: TicketId) => void;
    'send-supervisor-message': (ticketId: TicketId, message: string) => void;
    'reset-supervisor-session': (ticketId: TicketId) => void;
    'resolve-ticket': (ticketId: TicketId, resolution: TicketResolution) => void;
    'set-auto-dispatch': (projectId: ProjectId, enabled: boolean) => void;
    'get-supervisor-sandbox-status': (tabId: CodeTabId) => WithTimestamp<AgentProcessStatus> | null;
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
    'update-item': (
      id: MilestoneId,
      patch: Partial<Omit<Milestone, 'id' | 'projectId' | 'createdAt'>>
    ) => void;
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
    'add-item': (item: Omit<Page, 'id' | 'createdAt' | 'updatedAt'>, template?: import('@/lib/page-templates').TemplateKey) => Page;
    'update-item': (id: PageId, patch: Partial<Omit<Page, 'id' | 'projectId' | 'createdAt'>>) => void;
    'remove-item': (id: PageId) => void;
    'read-content': (pageId: PageId) => string;
    'write-content': (pageId: PageId, content: string) => void;
    'reorder': (pageId: PageId, newParentId: PageId | null, newSortOrder: number) => void;
    /** Subscribe to external-edit notifications for a page's file. Returns the current on-disk content. */
    'watch': (pageId: PageId) => { content: string } | null;
    /** Unsubscribe from external-edit notifications. */
    'unwatch': (pageId: PageId) => void;
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
    add: (input: {
      title: string;
      note?: string;
      projectId?: ProjectId | null;
      attachments?: string[];
    }) => InboxItem;
    /** Patch basic fields. Status transitions use the dedicated verbs below. */
    update: (
      id: InboxItemId,
      patch: Partial<Pick<InboxItem, 'title' | 'note' | 'projectId' | 'attachments'>>
    ) => void;
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
    fill: (
      handleId: import('@/shared/app-control-types').AppHandleId,
      ref: string,
      text: string
    ) => void;
    type: (handleId: import('@/shared/app-control-types').AppHandleId, text: string) => void;
    press: (handleId: import('@/shared/app-control-types').AppHandleId, key: string) => void;
    scroll: (
      handleId: import('@/shared/app-control-types').AppHandleId,
      options: { dx?: number; dy?: number; toTop?: boolean; toBottom?: boolean }
    ) => void;
    'inject-css': (handleId: import('@/shared/app-control-types').AppHandleId, css: string) => string;
    'remove-inserted-css': (
      handleId: import('@/shared/app-control-types').AppHandleId,
      key: string
    ) => void;
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
    'set-viewport': (
      handleId: import('@/shared/app-control-types').AppHandleId,
      options:
        | { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean }
        | { clear: true }
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
    'storage-clear': (
      handleId: import('@/shared/app-control-types').AppHandleId,
      which: 'local' | 'session'
    ) => void;
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
    'tabset-ensure': (id: BrowserTabsetId, opts?: { profileId?: BrowserProfileId; initialUrl?: string }) => BrowserTabset;
    'tabset-remove': (id: BrowserTabsetId) => void;
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
  AgentProcessIpcEvents &
  UtilIpcEvents &
  TerminalIpcEvents &
  StoreIpcEvents &
  ConfigIpcEvents &
  SkillsIpcEvents &
  ProjectIpcEvents &
  MilestoneIpcEvents &
  PageIpcEvents &
  InboxIpcEvents &
  PlatformIpcEvents &
  ExtensionIpcEvents &
  WorkspaceSyncIpcEvents &
  AppControlIpcEvents &
  BrowserIpcEvents;

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
    output: [string, string];
    exited: [string, number];
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
    pipeline: [ProjectId, Pipeline];
  }
>;

/**
 * Platform events. Main process emits these events, renderer process listens to them.
 */
/**
 * Page content events. Main process emits when a watched page file changes on
 * disk due to an external edit (e.g. the user edited context.md in their IDE).
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
export type IpcRendererEvents = TerminalIpcRendererEvents &
  MainProcessIpcRendererEvents &
  OmniInstallProcessIpcRendererEvents &
  AgentProcessIpcRendererEvents &
  DevIpcRendererEvents &
  StoreIpcRendererEvents &
  ProjectIpcRendererEvents &
  PageIpcRendererEvents &
  ToastIpcRendererEvents &
  PlatformIpcRendererEvents &
  ExtensionIpcRendererEvents &
  WorkspaceSyncIpcRendererEvents &
  BrowserIpcRendererEvents;

// #region Config file types

export type ModelEntry = {
  model: string;
  label?: string;
  realtime?: boolean;
  reasoning?: 'low' | 'medium' | 'high';
  max_input_tokens?: number;
  max_output_tokens?: number;
  api_key?: string;
  model_settings?: Record<string, unknown>;
};

export type ProviderEntry = {
  type: 'openai' | 'azure' | 'openai-compatible' | 'litellm';
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
