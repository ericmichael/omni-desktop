export type AppId = string;

export type AppKind =
  | 'builtin-chat'
  | 'builtin-code'
  | 'builtin-desktop'
  | 'builtin-browser'
  | 'builtin-terminal'
  | 'webview';

export type AppScope = 'always' | 'sandbox';
export type SandboxUrlKey = 'codeServerUrl' | 'noVncUrl';

export type AppDescriptor = {
  id: AppId;
  label: string;
  icon: string;
  kind: AppKind;
  url?: string;
  scope: AppScope;
  sandboxUrlKey?: SandboxUrlKey;
  builtin: boolean;
  order: number;
  /**
   * When true, the app appears in a code session's `EnvironmentDock`.
   * When false, the app is available only as a standalone global column (via
   * the app launcher). Built-ins default to true.
   */
  columnScoped: boolean;
};

export type CustomAppEntry = {
  id: AppId;
  label: string;
  icon: string;
  url: string;
  order: number;
  /**
   * When true, this custom app appears in every code session's dock and can
   * be driven column-scoped by agents in that session. When false (default),
   * the app is global-only — accessible as its own standalone deck column
   * via the app launcher, but hidden from the dock.
   */
  columnScoped?: boolean;
};

export const BUILTIN_APPS: AppDescriptor[] = [
  { id: 'chat', label: 'Chat', icon: 'Chat20Regular', kind: 'builtin-chat', scope: 'always', builtin: true, order: 0, columnScoped: true },
  {
    id: 'code',
    label: 'Code',
    icon: 'Code20Regular',
    kind: 'builtin-code',
    scope: 'sandbox',
    builtin: true,
    order: 10,
    sandboxUrlKey: 'codeServerUrl',
    columnScoped: true,
  },
  {
    id: 'desktop',
    label: 'Desktop',
    icon: 'Desktop20Regular',
    kind: 'builtin-desktop',
    scope: 'sandbox',
    builtin: true,
    order: 20,
    sandboxUrlKey: 'noVncUrl',
    columnScoped: true,
  },
  { id: 'browser', label: 'Browser', icon: 'Globe20Regular', kind: 'builtin-browser', scope: 'always', builtin: true, order: 30, columnScoped: true },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: 'WindowConsole20Regular',
    kind: 'builtin-terminal',
    scope: 'always',
    builtin: true,
    order: 40,
    columnScoped: true,
  },
];

export function buildAppRegistry(customApps: CustomAppEntry[]): AppDescriptor[] {
  const custom: AppDescriptor[] = customApps.map((c) => ({
    ...c,
    kind: 'webview' as const,
    scope: 'always' as const,
    builtin: false,
    columnScoped: c.columnScoped ?? false,
  }));
  return [...BUILTIN_APPS, ...custom].sort((a, b) => a.order - b.order);
}
