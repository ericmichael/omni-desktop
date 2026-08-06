import { Lightbulb, PlugZap, Puzzle, Settings, Trash2 } from 'lucide-react';
import { memo, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/ds/ui/alert-dialog';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/renderer/ds/ui/item';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { Switch } from '@/renderer/ds/ui/switch';
import { AppIcon } from '@/renderer/features/Code/AppIcon';
import type { InstalledPlugin, PluginKind } from '@/renderer/features/Plugins/plugin-cards';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { BundleUpdateInfo, McpServerEntry, SkillEntry } from '@/shared/types';

const KIND_LABELS: Record<PluginKind, string> = {
  connector: 'Connector',
  skill: 'Skill',
  app: 'App',
  extension: 'Extension',
};

function formatSkillSource(skill: SkillEntry): string {
  const parts: string[] = [];
  if (skill.version) {
    parts.push(`v${skill.version}`);
  }
  if (skill.source.kind === 'file') {
    parts.push(`Installed from ${skill.source.filename}`);
  } else if (skill.source.kind === 'marketplace') {
    parts.push(`Installed from ${skill.source.repo} · ${skill.source.plugin}`);
  } else {
    parts.push('Local');
  }
  return parts.join(' · ');
}

/** Short human-readable summary of what changed upstream. */
export function formatUpdateSummary(info: BundleUpdateInfo): string {
  const parts: string[] = [];
  if (info.liveVersion && info.liveVersion !== info.installedVersion) {
    parts.push(`v${info.installedVersion ?? '?'} → v${info.liveVersion}`);
  }
  if (info.addedSkills.length > 0) {
    parts.push(`+${info.addedSkills.length} skill${info.addedSkills.length === 1 ? '' : 's'}`);
  }
  if (info.removedSkills.length > 0) {
    parts.push(`-${info.removedSkills.length} removed`);
  }
  return parts.length > 0 ? `Update available · ${parts.join(' · ')}` : 'Update available';
}

function connectorSummary(server: McpServerEntry): string {
  const isStdio = !server.type || server.type === 'stdio';
  const summary = isStdio ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') : (server.url ?? '');
  return `${server.type ?? 'stdio'} · ${summary || '(not configured)'}`;
}

type InstalledSectionProps = {
  items: InstalledPlugin[];
  onRefresh: () => Promise<void>;
  onError: (message: string | null) => void;
  onConfigureConnector: (id: string) => void;
  /** Removes the server entry from McpConfig (the parent owns the config write). */
  onRemoveConnector: (id: string) => Promise<void>;
  /** Re-installs a bundle from its upstream marketplace (parent's install pipeline). */
  onUpdateBundle: (update: BundleUpdateInfo) => void;
  /** `skill:{repo}:{plugin}` while that bundle is installing/updating. */
  installingKey: string | null;
  /** Pending updates across all kinds: bundles + drifted connectors/apps. */
  updateAllCount: number;
  /** Updates every pending item in one click (parent's install pipeline). */
  onUpdateAll: () => void;
};

export const InstalledSection = memo(
  ({
    items,
    onRefresh,
    onError,
    onConfigureConnector,
    onRemoveConnector,
    onUpdateBundle,
    installingKey,
    updateAllCount,
    onUpdateAll,
  }: InstalledSectionProps) => {
    const [uninstallSkill, setUninstallSkill] = useState<SkillEntry | null>(null);
    const [removeConnectorId, setRemoveConnectorId] = useState<string | null>(null);

    if (items.length === 0) {
      return null;
    }

    const run = async (action: () => Promise<unknown>, failureMessage: string) => {
      onError(null);
      try {
        await action();
        await onRefresh();
      } catch (e) {
        onError(e instanceof Error ? e.message : failureMessage);
      }
    };

    const toggleApp = (id: string, columnScoped: boolean) => {
      const current = persistedStoreApi.$atom.get().customApps ?? [];
      void persistedStoreApi.setKey(
        'customApps',
        current.map((a) => (a.id === id ? { ...a, columnScoped } : a))
      );
    };

    const removeApp = (id: string) => {
      const current = persistedStoreApi.$atom.get().customApps ?? [];
      void persistedStoreApi.setKey(
        'customApps',
        current.filter((a) => a.id !== id)
      );
    };

    const updatingAll = installingKey === 'update-all';

    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Installed</span>
          {updateAllCount > 0 && (
            <Button size="sm" variant="ghost" onClick={onUpdateAll} disabled={installingKey !== null}>
              {updatingAll ? <Spinner /> : `Update all (${updateAllCount})`}
            </Button>
          )}
        </div>

        <ItemGroup className="gap-2">
          {items.map((item) => {
            switch (item.kind) {
              case 'connector':
                return (
                  <Item key={`connector:${item.id}`} variant="outline">
                    <ItemMedia variant="icon">
                      <PlugZap className="text-primary" />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="max-w-full">
                        <span className="truncate">{item.id}</span>
                        <Badge variant="secondary">{KIND_LABELS.connector}</Badge>
                        {item.runtime && (
                          <Badge variant={item.runtime.status.state === 'failed' ? 'destructive' : 'outline'}>
                            {item.runtime.status.state}
                          </Badge>
                        )}
                        {item.runtime?.read_only && <Badge variant="secondary">Managed</Badge>}
                      </ItemTitle>
                      <ItemDescription>{connectorSummary(item.server)}</ItemDescription>
                      {item.runtime?.disabled_reason && (
                        <span className="text-xs text-muted-foreground">{item.runtime.disabled_reason}</span>
                      )}
                      {item.runtime?.read_only && (
                        <span className="text-xs text-muted-foreground">
                          Managed by the Omniagents host
                          {item.runtime.read_only_reason ? ` · ${item.runtime.read_only_reason}` : ''}
                        </span>
                      )}
                    </ItemContent>
                    {!item.runtime?.read_only && (
                      <ItemActions>
                        <Button size="sm" variant="ghost" onClick={() => onConfigureConnector(item.id)}>
                          <Settings className="mr-1 size-4" />
                          Configure
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${item.id}`}
                          onClick={() => setRemoveConnectorId(item.id)}
                        >
                          <Trash2 />
                        </Button>
                      </ItemActions>
                    )}
                  </Item>
                );

              case 'skill': {
                const { skill, update } = item;
                const updating = update !== undefined && installingKey === `skill:${update.repo}:${update.plugin}`;
                return (
                  <Item key={`skill:${skill.name}`} variant="outline">
                    <ItemMedia variant="icon">
                      <Lightbulb className="text-primary" />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="max-w-full">
                        <span className="truncate">{skill.name}</span>
                        <Badge variant="secondary">{KIND_LABELS.skill}</Badge>
                      </ItemTitle>
                      <ItemDescription>{skill.description}</ItemDescription>
                      <span className="text-xs text-muted-foreground">{formatSkillSource(skill)}</span>
                      {update && (
                        <Badge className="mt-1 text-success" variant="outline">
                          {formatUpdateSummary(update)}
                        </Badge>
                      )}
                    </ItemContent>
                    <ItemActions>
                      {update && (
                        <Button size="sm" onClick={() => onUpdateBundle(update)} disabled={installingKey !== null}>
                          {updating ? <Spinner /> : 'Update'}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Uninstall ${skill.name}`}
                        onClick={() => setUninstallSkill(skill)}
                      >
                        <Trash2 />
                      </Button>

                      <Switch
                        checked={skill.enabled}
                        onCheckedChange={(enabled) =>
                          run(() => emitter.invoke('skills:set-enabled', skill.name, enabled), 'Failed to update skill')
                        }
                      />
                    </ItemActions>
                  </Item>
                );
              }

              case 'app':
                return (
                  <Item key={`app:${item.app.id}`} variant="outline">
                    <ItemMedia variant="icon">
                      <AppIcon icon={item.app.icon} size={20} />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="max-w-full">
                        <span className="truncate">{item.app.label}</span>
                        <Badge variant="secondary">{KIND_LABELS.app}</Badge>
                      </ItemTitle>
                      <ItemDescription>{item.app.url}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <label
                        className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer select-none shrink-0"
                        title="Show in the session dock (column-scoped). When off, the app only opens as its own deck column."
                      >
                        <span>In dock</span>
                        <Switch
                          checked={item.app.columnScoped ?? false}
                          onCheckedChange={(v) => toggleApp(item.app.id, v)}
                        />
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${item.app.label}`}
                        onClick={() => removeApp(item.app.id)}
                      >
                        <Trash2 />
                      </Button>
                    </ItemActions>
                  </Item>
                );

              case 'extension':
                return (
                  <Item key={`extension:${item.ext.id}`} variant="outline">
                    <ItemMedia variant="icon">
                      <Puzzle className="text-primary" />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="max-w-full">
                        <span className="truncate">{item.ext.name}</span>
                        <Badge variant="secondary">{KIND_LABELS.extension}</Badge>
                      </ItemTitle>
                      <ItemDescription>{item.ext.description}</ItemDescription>
                      {item.ext.contentTypes.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {item.ext.contentTypes.map((ct) => (
                            <Badge key={ct.id} variant="outline">
                              {ct.label} ({ct.fileExtension})
                            </Badge>
                          ))}
                        </div>
                      )}
                    </ItemContent>
                    <ItemActions>
                      <Switch
                        checked={item.ext.enabled}
                        onCheckedChange={(enabled) =>
                          run(
                            () => emitter.invoke('extension:set-enabled', item.ext.id, enabled),
                            'Failed to update extension'
                          )
                        }
                      />
                    </ItemActions>
                  </Item>
                );
            }
          })}
        </ItemGroup>

        <AlertDialog open={uninstallSkill !== null} onOpenChange={(open) => !open && setUninstallSkill(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{`Uninstall "${uninstallSkill?.name}"?`}</AlertDialogTitle>
              <AlertDialogDescription>This will permanently remove the skill and all its files.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  const skill = uninstallSkill;
                  if (skill) {
                    void run(() => emitter.invoke('skills:uninstall', skill.name), 'Failed to uninstall skill');
                  }
                }}
              >
                Uninstall
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={removeConnectorId !== null} onOpenChange={(open) => !open && setRemoveConnectorId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{`Remove "${removeConnectorId}"?`}</AlertDialogTitle>
              <AlertDialogDescription>
                Agent sessions will no longer have access to this MCP server.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  const id = removeConnectorId;
                  if (id) {
                    void run(() => onRemoveConnector(id), 'Failed to remove connector');
                  }
                }}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }
);
InstalledSection.displayName = 'InstalledSection';
