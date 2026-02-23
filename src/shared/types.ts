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
export type LayoutMode = 'work' | 'code' | 'desktop' | 'fleet';
export type OmniTheme = 'default' | 'tokyo-night' | 'vscode-dark' | 'vscode-light';

export type StoreData = {
  workspaceDir?: string;
  enableCodeServer: boolean;
  enableVnc: boolean;
  useWorkDockerfile: boolean;
  launcherWindowProps?: WindowProps;
  appWindowProps?: WindowProps;
  optInToLauncherPrereleases: boolean;
  enableFleet: boolean;
  layoutMode: LayoutMode;
  theme: OmniTheme;
  onboardingComplete: boolean;
  fleetProjects: FleetProject[];
  fleetTasks: FleetTask[];
  fleetTickets: FleetTicket[];
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
  enableCodeServer: {
    type: 'boolean',
    default: true,
  },
  enableVnc: {
    type: 'boolean',
    default: true,
  },
  useWorkDockerfile: {
    type: 'boolean',
    default: true,
  },
  launcherWindowProps: winSizePropsSchema,
  appWindowProps: winSizePropsSchema,
  optInToLauncherPrereleases: {
    type: 'boolean',
    default: false,
  },
  enableFleet: {
    type: 'boolean',
    default: false,
  },
  layoutMode: {
    type: 'string',
    enum: ['work', 'code', 'desktop', 'fleet'],
    default: 'work',
  },
  theme: {
    type: 'string',
    enum: ['default', 'tokyo-night', 'vscode-dark', 'vscode-light'],
    default: 'tokyo-night',
  },
  onboardingComplete: {
    type: 'boolean',
    default: false,
  },
  fleetProjects: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        workspaceDir: { type: 'string' },
        createdAt: { type: 'number' },
      },
      required: ['id', 'label', 'workspaceDir', 'createdAt'],
    },
  },
  fleetTasks: {
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
        iteration: { type: 'number' },
      },
      required: ['id', 'projectId', 'taskDescription', 'status', 'createdAt'],
    },
  },
  fleetTickets: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        projectId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        status: { type: 'string', enum: ['open', 'in_progress', 'completed', 'closed'] },
        blockedBy: { type: 'array', items: { type: 'string' } },
        taskId: { type: 'string' },
        createdAt: { type: 'number' },
        updatedAt: { type: 'number' },
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

export type SandboxProcessStatus =
  | Status<'uninitialized' | 'starting' | 'stopping' | 'exiting' | 'exited'>
  | OkStatus<
      'running',
      {
        sandboxUrl: string;
        wsUrl: string;
        uiUrl: string;
        codeServerUrl?: string;
        noVncUrl?: string;
        containerId?: string;
        containerName?: string;
        ports: {
          sandbox: number;
          ui: number;
          codeServer?: number;
          vnc?: number;
        };
      }
    >;

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
      pythonVersion: string;
      omniPath: string;
    };

// #region Fleet types

export type FleetProjectId = string;
export type FleetTaskId = string;
export type FleetTicketId = string;
export type FleetTicketStatus = 'open' | 'in_progress' | 'completed' | 'closed';
export type FleetTicketPriority = 'low' | 'medium' | 'high' | 'critical';

export type FleetProject = {
  id: FleetProjectId;
  label: string;
  workspaceDir: string;
  createdAt: number;
};

export type FleetTicketLoopStatus = 'running' | 'completed' | 'stopped' | 'error';

export type FleetTicket = {
  id: FleetTicketId;
  projectId: FleetProjectId;
  title: string;
  description: string;
  priority: FleetTicketPriority;
  status: FleetTicketStatus;
  blockedBy: FleetTicketId[];
  taskId?: FleetTaskId;
  createdAt: number;
  updatedAt: number;
  loopEnabled?: boolean;
  loopMaxIterations?: number;
  loopIteration?: number;
  loopStatus?: FleetTicketLoopStatus;
};

export type FleetTask = {
  id: FleetTaskId;
  projectId: FleetProjectId;
  taskDescription: string;
  status: WithTimestamp<SandboxProcessStatus>;
  createdAt: number;
  branch?: string;
  worktreePath?: string;
  worktreeName?: string;
  sessionId?: string;
  ticketId?: FleetTicketId;
  iteration?: number;
};

export type FleetTaskSubmitOptions = {
  branch?: string;
  useWorktree?: boolean;
  loop?: boolean;
  loopMaxIterations?: number;
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

type SandboxProcessIpcEvents = Namespaced<
  'sandbox-process',
  {
    'get-status': () => WithTimestamp<SandboxProcessStatus>;
    start: (arg: {
      workspaceDir: string;
      enableCodeServer: boolean;
      enableVnc: boolean;
      useWorkDockerfile: boolean;
    }) => void;
    stop: () => void;
    rebuild: () => void;
    resize: (cols: number, rows: number) => void;
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
 * Fleet API. Main process handles these events, renderer process invokes them.
 */
type FleetIpcEvents = Namespaced<
  'fleet',
  {
    'add-project': (project: Omit<FleetProject, 'id' | 'createdAt'>) => FleetProject;
    'update-project': (id: FleetProjectId, patch: Partial<Omit<FleetProject, 'id' | 'createdAt'>>) => void;
    'remove-project': (id: FleetProjectId) => void;
    'check-git-repo': (workspaceDir: string) => GitRepoInfo;
    'submit-task': (projectId: FleetProjectId, taskDescription: string, options: FleetTaskSubmitOptions) => FleetTask;
    'get-tasks': () => FleetTask[];
    'stop-task': (taskId: FleetTaskId) => void;
    'remove-task': (taskId: FleetTaskId) => void;
    'add-ticket': (ticket: Omit<FleetTicket, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'taskId'>) => FleetTicket;
    'update-ticket': (id: FleetTicketId, patch: Partial<Omit<FleetTicket, 'id' | 'projectId' | 'createdAt'>>) => void;
    'remove-ticket': (id: FleetTicketId) => void;
    'get-tickets': (projectId: FleetProjectId) => FleetTicket[];
    'get-next-ticket': (projectId: FleetProjectId) => FleetTicket | null;
    'submit-ticket-task': (ticketId: FleetTicketId, options: FleetTaskSubmitOptions) => FleetTask;
    'stop-loop': (ticketId: FleetTicketId) => void;
    'resume-loop': (ticketId: FleetTicketId) => void;
  }
>;

/**
 * Intersection of all the events that the renderer can invoke and main process can handle.
 */
export type IpcEvents = MainProcessIpcEvents &
  OmniInstallProcessIpcEvents &
  SandboxProcessIpcEvents &
  UtilIpcEvents &
  TerminalIpcEvents &
  StoreIpcEvents &
  ConfigIpcEvents &
  FleetIpcEvents;

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

type SandboxProcessIpcRendererEvents = Namespaced<
  'sandbox-process',
  {
    status: [WithTimestamp<SandboxProcessStatus>];
    log: [WithTimestamp<LogEntry>];
    'raw-output': [string];
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
 * Fleet events. Main process emits these events, renderer process listens to them.
 */
export type FleetTicketLoopUpdate = {
  iteration: number;
  maxIterations: number;
  status: FleetTicketLoopStatus;
};

type FleetIpcRendererEvents = Namespaced<
  'fleet',
  {
    'task-status': [FleetTaskId, WithTimestamp<SandboxProcessStatus>];
    'task-session': [FleetTaskId, string];
    'task-log': [FleetTaskId, WithTimestamp<LogEntry>];
    'task-raw-output': [FleetTaskId, string];
    'ticket-loop-update': [FleetTicketId, FleetTicketLoopUpdate];
  }
>;

/**
 * Intersection of all the events emitted by main process that the renderer can listen to.
 */
export type IpcRendererEvents = TerminalIpcRendererEvents &
  MainProcessIpcRendererEvents &
  OmniInstallProcessIpcRendererEvents &
  SandboxProcessIpcRendererEvents &
  DevIpcRendererEvents &
  StoreIpcRendererEvents &
  FleetIpcRendererEvents &
  ToastIpcRendererEvents;

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

// #endregion
