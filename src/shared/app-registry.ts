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
};

export type CustomAppEntry = {
  id: AppId;
  label: string;
  icon: string;
  url: string;
  order: number;
};

export const BUILTIN_APPS: AppDescriptor[] = [
  { id: 'chat', label: 'Chat', icon: 'Chat20Regular', kind: 'builtin-chat', scope: 'always', builtin: true, order: 0 },
  {
    id: 'code',
    label: 'Code',
    icon: 'Code20Regular',
    kind: 'builtin-code',
    scope: 'sandbox',
    builtin: true,
    order: 10,
    sandboxUrlKey: 'codeServerUrl',
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
  },
  { id: 'browser', label: 'Browser', icon: 'Globe20Regular', kind: 'builtin-browser', scope: 'always', builtin: true, order: 30 },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: 'WindowConsole20Regular',
    kind: 'builtin-terminal',
    scope: 'always',
    builtin: true,
    order: 40,
  },
];

export function buildAppRegistry(customApps: CustomAppEntry[]): AppDescriptor[] {
  const custom: AppDescriptor[] = customApps.map((c) => ({
    ...c,
    kind: 'webview' as const,
    scope: 'always' as const,
    builtin: false,
  }));
  return [...BUILTIN_APPS, ...custom].sort((a, b) => a.order - b.order);
}
