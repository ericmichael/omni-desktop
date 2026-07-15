import { makeStyles, tokens } from '@fluentui/react-components';
import {
  Delete20Regular,
  Lightbulb20Regular,
  PlugConnected20Regular,
  PuzzlePiece20Regular,
  Settings20Regular,
} from '@fluentui/react-icons';
import { memo, useState } from 'react';

import { Button, ConfirmDialog, IconButton, SectionLabel, Spinner, Switch } from '@/renderer/ds';
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

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  cardHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  cardIcon: { display: 'flex', color: tokens.colorBrandForeground1, flexShrink: 0 },
  cardTitle: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 600,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
  },
  kindChip: {
    fontSize: tokens.fontSizeBase100,
    padding: `2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground2,
    flexShrink: 0,
  },
  cardDescription: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  cardMeta: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground4 },
  updateRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  updateBadge: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorPaletteGreenForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  contentTypes: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  dockToggleLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    userSelect: 'none',
    flexShrink: 0,
  },
});

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
    const styles = useStyles();
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
      <div className={styles.root}>
        <div className={styles.sectionHeader}>
          <SectionLabel>Installed</SectionLabel>
          {updateAllCount > 0 && (
            <Button size="sm" variant="ghost" onClick={onUpdateAll} isDisabled={installingKey !== null}>
              {updatingAll ? <Spinner size="sm" /> : `Update all (${updateAllCount})`}
            </Button>
          )}
        </div>

        {items.map((item) => {
          switch (item.kind) {
            case 'connector':
              return (
                <div key={`connector:${item.id}`} className={styles.card}>
                  <div className={styles.cardHeader}>
                    <span className={styles.cardIcon}>
                      <PlugConnected20Regular />
                    </span>
                    <span className={styles.cardTitle}>{item.id}</span>
                    <span className={styles.kindChip}>{KIND_LABELS.connector}</span>
                    <Button size="sm" variant="ghost" onClick={() => onConfigureConnector(item.id)}>
                      <Settings20Regular style={{ marginRight: 4 }} />
                      Configure
                    </Button>
                    <IconButton
                      aria-label={`Remove ${item.id}`}
                      icon={<Delete20Regular />}
                      size="sm"
                      onClick={() => setRemoveConnectorId(item.id)}
                    />
                  </div>
                  <div className={styles.cardDescription}>{connectorSummary(item.server)}</div>
                </div>
              );

            case 'skill': {
              const { skill, update } = item;
              const updating = update !== undefined && installingKey === `skill:${update.repo}:${update.plugin}`;
              return (
                <div key={`skill:${skill.name}`} className={styles.card}>
                  <div className={styles.cardHeader}>
                    <span className={styles.cardIcon}>
                      <Lightbulb20Regular />
                    </span>
                    <span className={styles.cardTitle}>{skill.name}</span>
                    <span className={styles.kindChip}>{KIND_LABELS.skill}</span>
                    <IconButton
                      aria-label={`Uninstall ${skill.name}`}
                      icon={<Delete20Regular />}
                      size="sm"
                      onClick={() => setUninstallSkill(skill)}
                    />
                    <Switch
                      checked={skill.enabled}
                      onCheckedChange={(enabled) =>
                        run(() => emitter.invoke('skills:set-enabled', skill.name, enabled), 'Failed to update skill')
                      }
                    />
                  </div>
                  <div className={styles.cardDescription}>{skill.description}</div>
                  <div className={styles.cardMeta}>{formatSkillSource(skill)}</div>
                  {update && (
                    <div className={styles.updateRow}>
                      <span className={styles.updateBadge}>{formatUpdateSummary(update)}</span>
                      <Button size="sm" onClick={() => onUpdateBundle(update)} isDisabled={installingKey !== null}>
                        {updating ? <Spinner size="sm" /> : 'Update'}
                      </Button>
                    </div>
                  )}
                </div>
              );
            }

            case 'app':
              return (
                <div key={`app:${item.app.id}`} className={styles.card}>
                  <div className={styles.cardHeader}>
                    <span className={styles.cardIcon}>
                      <AppIcon icon={item.app.icon} size={20} />
                    </span>
                    <span className={styles.cardTitle}>{item.app.label}</span>
                    <span className={styles.kindChip}>{KIND_LABELS.app}</span>
                    <label
                      className={styles.dockToggleLabel}
                      title="Show in the session dock (column-scoped). When off, the app only opens as its own deck column."
                    >
                      <span>In dock</span>
                      <Switch
                        checked={item.app.columnScoped ?? false}
                        onCheckedChange={(v) => toggleApp(item.app.id, v)}
                      />
                    </label>
                    <IconButton
                      aria-label={`Remove ${item.app.label}`}
                      icon={<Delete20Regular />}
                      size="sm"
                      onClick={() => removeApp(item.app.id)}
                    />
                  </div>
                  <div className={styles.cardDescription}>{item.app.url}</div>
                </div>
              );

            case 'extension':
              return (
                <div key={`extension:${item.ext.id}`} className={styles.card}>
                  <div className={styles.cardHeader}>
                    <span className={styles.cardIcon}>
                      <PuzzlePiece20Regular />
                    </span>
                    <span className={styles.cardTitle}>{item.ext.name}</span>
                    <span className={styles.kindChip}>{KIND_LABELS.extension}</span>
                    <Switch
                      checked={item.ext.enabled}
                      onCheckedChange={(enabled) =>
                        run(
                          () => emitter.invoke('extension:set-enabled', item.ext.id, enabled),
                          'Failed to update extension'
                        )
                      }
                    />
                  </div>
                  <div className={styles.cardDescription}>{item.ext.description}</div>
                  {item.ext.contentTypes.length > 0 && (
                    <div className={styles.contentTypes}>
                      {item.ext.contentTypes.map((ct) => (
                        <span key={ct.id} className={styles.kindChip}>
                          {ct.label} ({ct.fileExtension})
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
          }
        })}

        <ConfirmDialog
          open={uninstallSkill !== null}
          onClose={() => setUninstallSkill(null)}
          onConfirm={() => {
            const skill = uninstallSkill;
            setUninstallSkill(null);
            if (skill) {
              void run(() => emitter.invoke('skills:uninstall', skill.name), 'Failed to uninstall skill');
            }
          }}
          title={`Uninstall "${uninstallSkill?.name}"?`}
          description="This will permanently remove the skill and all its files."
          confirmLabel="Uninstall"
          destructive
        />

        <ConfirmDialog
          open={removeConnectorId !== null}
          onClose={() => setRemoveConnectorId(null)}
          onConfirm={() => {
            const id = removeConnectorId;
            setRemoveConnectorId(null);
            if (id) {
              void run(() => onRemoveConnector(id), 'Failed to remove connector');
            }
          }}
          title={`Remove "${removeConnectorId}"?`}
          description="Agent sessions will no longer have access to this MCP server."
          confirmLabel="Remove"
          destructive
        />
      </div>
    );
  }
);
InstalledSection.displayName = 'InstalledSection';
