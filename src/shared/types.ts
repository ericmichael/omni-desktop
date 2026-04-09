import type { Rectangle } from 'electron/main';
import type { Schema } from 'electron-store';

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
export type LayoutMode = 'chat' | 'code' | 'projects' | 'dashboards' | 'more';
export type OmniTheme = 'default' | 'tokyo-night' | 'vscode-dark' | 'vscode-light' | 'utrgv';

export type SandboxVariant = 'standard' | 'work';
export type SandboxBackend = 'docker' | 'podman' | 'vm' | 'local';

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
  sandboxEnabled: boolean;
  sandboxVariant: SandboxVariant;
  sandboxBackend: SandboxBackend;
  launcherWindowProps?: WindowProps;
  appWindowProps?: WindowProps;
  optInToLauncherPrereleases: boolean;
  previewFeatures: boolean;

  layoutMode: LayoutMode;
  theme: OmniTheme;
  onboardingComplete: boolean;
  projects: Project[];
  initiatives: Initiative[];
  tasks: Task[];
  tickets: Ticket[];
  inboxItems: InboxItem[];
  schemaVersion: number;
  codeTabs: CodeTab[];
  activeCodeTabId: CodeTabId | null;
  codeLayoutMode: CodeLayoutMode;
  activeTicketId: TicketId | null;

  // Enterprise platform (optional — when set, enables enterprise mode)
  platform?: PlatformCredentials;
};

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
  sandboxEnabled: {
    type: 'boolean',
    default: false,
  },
  sandboxVariant: {
    type: 'string',
    enum: ['standard', 'work'],
    default: 'work',
  },
  sandboxBackend: {
    type: 'string',
    enum: ['docker', 'podman', 'vm', 'local'],
    default: 'docker',
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
    enum: ['chat', 'code', 'projects'],
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
  schemaVersion: {
    type: 'number',
    default: 0,
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
        workspaceDir: { type: 'string' },
        createdAt: { type: 'number' },
        pipeline: { type: 'object' },
        sandbox: { type: ['object', 'null'] },
      },
      required: ['id', 'label', 'workspaceDir', 'createdAt'],
    },
  },
  initiatives: {
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
        isDefault: { type: 'boolean' },
        createdAt: { type: 'number' },
        updatedAt: { type: 'number' },
      },
      required: ['id', 'projectId', 'title', 'description', 'status', 'createdAt', 'updatedAt'],
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
        initiativeId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        status: { type: 'string', enum: ['open', 'in_progress', 'completed', 'closed'] },
        blockedBy: { type: 'array', items: { type: 'string' } },
        createdAt: { type: 'number' },
        updatedAt: { type: 'number' },
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
        'status',
        'blockedBy',
        'createdAt',
        'updatedAt',
      ],
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
        description: { type: 'string' },
        attachments: { type: 'array', items: { type: 'string' } },
        projectId: { type: ['string', 'null'] },
        linkedTicketIds: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['open', 'done', 'deferred'] },
        createdAt: { type: 'number' },
        updatedAt: { type: 'number' },
      },
      required: ['id', 'title', 'status', 'createdAt', 'updatedAt'],
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
  createdAt: number;
};

// #endregion

// #region Project & Ticket types

// --- ID types ---

export type ProjectId = string;
export type InitiativeId = string;
export type TaskId = string;
export type TicketId = string;
export type TicketCommentId = string;
export type ColumnId = string;
export type InboxItemId = string;

// --- Enums ---

export type TicketPriority = 'low' | 'medium' | 'high' | 'critical';
export type TicketResolution = 'completed' | 'wont_do' | 'duplicate' | 'cancelled';
export type InitiativeStatus = 'active' | 'completed' | 'archived';

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

export type Project = {
  id: ProjectId;
  label: string;
  workspaceDir: string;
  createdAt: number;
  /** Pipeline configuration. If undefined, DEFAULT_PIPELINE is used. */
  pipeline?: Pipeline;
  /** When true, automatically dispatch tickets from backlog in priority order. */
  autoDispatch?: boolean;
  /** Per-project sandbox configuration. When absent/null, the default sandbox image is used. */
  sandbox?: SandboxConfig | null;
  /** Project brief — a living document that captures problem, appetite, scope, and open questions. */
  brief?: string;
};

export type Initiative = {
  id: InitiativeId;
  projectId: ProjectId;
  title: string;
  description: string;
  /** Optional feature branch. Tickets inherit this unless they override with their own branch. */
  branch?: string;
  /** Initiative brief — describes the deliverable, goals, and scope. */
  brief?: string;
  status: InitiativeStatus;
  /** True for the auto-created "General" initiative. Cannot be deleted. */
  isDefault?: boolean;
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
  initiativeId: InitiativeId;
  title: string;
  description: string;
  priority: TicketPriority;
  blockedBy: TicketId[];
  createdAt: number;
  updatedAt: number;

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
  /** Task ID for the supervisor's sandbox. */
  supervisorTaskId?: TaskId;
  /** Accumulated token usage across all supervisor runs. */
  tokenUsage?: TokenUsage;
  /** Resolution reason when ticket is closed. Undefined means open. */
  resolution?: TicketResolution;
  /** Agent/human comments — serves as persistent memory across runs. */
  comments?: TicketComment[];
  /** History of supervisor runs on this ticket. */
  runs?: TicketRun[];
};

// --- Inbox ---

export type InboxItemStatus = 'open' | 'done' | 'deferred';

export type InboxItem = {
  id: InboxItemId;
  title: string;
  description?: string;
  attachments?: string[];
  projectId?: ProjectId;
  linkedTicketIds?: TicketId[];
  linkedInitiativeId?: InitiativeId;
  status: InboxItemStatus;
  createdAt: number;
  updatedAt: number;
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
    'select-file': (path?: string) => string | null;
    'get-home-directory': () => string;
    'get-is-directory': (path: string) => boolean;
    'get-is-file': (path: string) => boolean;
    'get-path-exists': (path: string) => boolean;
    'get-os': () => OperatingSystem;
    'get-default-install-dir': () => string;
    'get-default-workspace-dir': () => string;
    'ensure-directory': (path: string) => boolean;
    'open-directory': (path: string) => string;
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
 * Project & Ticket API. Main process handles these events, renderer process invokes them.
 */
type ProjectIpcEvents = Namespaced<
  'project',
  {
    'add-project': (project: Omit<Project, 'id' | 'createdAt'>) => Project;
    'update-project': (id: ProjectId, patch: Partial<Omit<Project, 'id' | 'createdAt'>>) => void;
    'remove-project': (id: ProjectId) => void;
    'check-git-repo': (workspaceDir: string) => GitRepoInfo;
    'add-ticket': (
      ticket: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'columnId' | 'initiativeId'> & { initiativeId?: InitiativeId }
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
 * Inbox API. Main process handles these events, renderer process invokes them.
 */
type InboxIpcEvents = Namespaced<
  'inbox',
  {
    'get-items': () => InboxItem[];
    'add-item': (item: Omit<InboxItem, 'id' | 'createdAt' | 'updatedAt'>) => InboxItem;
    'update-item': (id: InboxItemId, patch: Partial<Omit<InboxItem, 'id' | 'createdAt'>>) => void;
    'remove-item': (id: InboxItemId) => void;
  }
>;

/**
 * Initiative API. Main process handles these events, renderer process invokes them.
 */
type InitiativeIpcEvents = Namespaced<
  'initiative',
  {
    'get-items': (projectId: ProjectId) => Initiative[];
    'add-item': (item: Omit<Initiative, 'id' | 'createdAt' | 'updatedAt'>) => Initiative;
    'update-item': (
      id: InitiativeId,
      patch: Partial<Omit<Initiative, 'id' | 'projectId' | 'createdAt'>>
    ) => void;
    'remove-item': (id: InitiativeId) => void;
  }
>;

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
  ProjectIpcEvents &
  InboxIpcEvents &
  InitiativeIpcEvents &
  PlatformIpcEvents;

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
type PlatformIpcRendererEvents = Namespaced<
  'platform',
  {
    /** Emitted when auth state changes (sign in / sign out / token refresh). */
    'auth-changed': [PlatformCredentials | null];
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
  ToastIpcRendererEvents &
  PlatformIpcRendererEvents;

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
