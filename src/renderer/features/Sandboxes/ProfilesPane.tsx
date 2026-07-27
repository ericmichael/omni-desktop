/**
 * Sandboxes → Profiles: the discovered profile catalog. Read-only in v1
 * (sandboxes-tab-plan.md Decision 4): parsed summary + raw YAML, with
 * "Set as default" / "Create override" / copy-path as the only actions.
 */

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Badge, Body1, Button, Caption1, Card, SectionLabel } from '@/renderer/ds';
import { $sandboxesError, $sandboxProfiles, refreshSandboxProfiles } from '@/renderer/features/Sandboxes/state';
import { emitter, isCloudLinked, isElectron, isServerLinked, isWslLinked } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ProfileSummary } from '@/shared/types';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  list: { display: 'flex', flexDirection: 'column' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
    width: '100%',
    textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: tokens.colorBrandStroke1,
      outlineOffset: '-2px',
    },
  },
  rowSelected: { backgroundColor: tokens.colorSubtleBackgroundSelected },
  rowMain: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  chips: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexShrink: 0 },
  summary: { color: tokens.colorNeutralForeground2 },
  error: { color: tokens.colorPaletteRedForeground1 },
  detail: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  detailHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
  },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  mono: { fontFamily: tokens.fontFamilyMonospace },
  yaml: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalS,
    overflowX: 'auto',
    whiteSpace: 'pre',
    margin: 0,
  },
  pathRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  pathText: {
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
});

const ORIGIN_LABELS: Record<ProfileSummary['origin'], string> = {
  builtin: 'built-in',
  'user-override': 'override',
  implicit: 'implicit',
};

/**
 * "Reveal in file manager" opens the path with the LOCAL shell — only
 * meaningful when the profile file lives on this machine, i.e. standalone
 * Electron. Remote-linked clients (wsl/cloud/server) see backend paths.
 */
const canReveal = isElectron && !isCloudLinked && !isWslLinked && !isServerLinked;

/** Directory part of a profile path, tolerant of Windows separators. */
const dirnameOf = (p: string): string => {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return cut > 0 ? p.slice(0, cut) : p;
};

const copyText = (text: string): void => {
  void navigator.clipboard.writeText(text).catch(() => undefined);
};

export const ProfilesPane = memo(() => {
  const styles = useStyles();
  const profiles = useStore($sandboxProfiles);
  const fetchError = useStore($sandboxesError);
  const store = useStore(persistedStoreApi.$atom);

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [yaml, setYaml] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createdPath, setCreatedPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void refreshSandboxProfiles();
  }, []);

  const selected = profiles.find((p) => p.name === selectedName) ?? null;

  const selectProfile = useCallback((name: string) => {
    setSelectedName(name);
    setYaml(null);
    setActionError(null);
    setCreatedPath(null);
    setCopied(false);
    void emitter
      .invoke('sandbox:read-profile', name)
      .then((result) => setYaml(result?.yaml ?? null))
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)));
  }, []);

  const onSetDefault = useCallback(() => {
    if (selected) {
      // Same mechanism as the Settings → Workspace picker.
      void persistedStoreApi.setKey('defaultProfileName', selected.name);
    }
  }, [selected]);

  const onCreateOverride = useCallback(() => {
    if (!selected) {
      return;
    }
    const name = selected.name;
    setActionError(null);
    void emitter
      .invoke('sandbox:create-override', name)
      .then(async ({ path }) => {
        await refreshSandboxProfiles();
        // Re-select so the detail shows the new override's YAML + path.
        selectProfile(name);
        setCreatedPath(path);
      })
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)));
  }, [selected, selectProfile]);

  const onCopyPath = useCallback(() => {
    if (selected?.path) {
      copyText(selected.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [selected]);

  const onReveal = useCallback(() => {
    if (selected?.path) {
      void emitter.invoke('util:open-directory', dirnameOf(selected.path));
    }
  }, [selected]);

  const defaultName = store.defaultProfileName ?? 'host';
  const usedByCount = selected ? store.projects.filter((p) => p.sandboxProfile === selected.name).length : 0;

  return (
    <div className={styles.root}>
      <SectionLabel>Profiles</SectionLabel>
      <Card>
        <div className={styles.list}>
          {profiles.length === 0 && <Caption1 className={styles.summary}>Discovering profiles…</Caption1>}
          {profiles.map((profile) => (
            <button
              key={profile.name}
              type="button"
              className={mergeClasses(styles.row, profile.name === selectedName && styles.rowSelected)}
              onClick={() => selectProfile(profile.name)}
            >
              <div className={styles.rowMain}>
                <Body1>{profile.label}</Body1>
                <Caption1 className={mergeClasses(styles.summary, styles.mono)}>{profile.name}</Caption1>
              </div>
              <div className={styles.chips}>
                {profile.name === defaultName && <Badge color="green">default</Badge>}
                <Badge color="blue">{profile.clientType}</Badge>
                <Badge>{ORIGIN_LABELS[profile.origin]}</Badge>
              </div>
            </button>
          ))}
        </div>
        {fetchError && <Caption1 className={styles.error}>{fetchError}</Caption1>}
      </Card>

      {selected && (
        <Card>
          <div className={styles.detail}>
            <div className={styles.detailHeader}>
              <div className={styles.rowMain}>
                <Body1>{selected.label}</Body1>
                {usedByCount > 0 && (
                  <Caption1 className={styles.summary}>
                    {`Used by ${usedByCount} ${usedByCount === 1 ? 'project' : 'projects'}`}
                  </Caption1>
                )}
              </div>
              <div className={styles.actions}>
                {selected.name !== defaultName && (
                  <Button size="sm" variant="ghost" onClick={onSetDefault}>
                    Set as default
                  </Button>
                )}
                {selected.origin === 'builtin' && (
                  <Button size="sm" variant="ghost" onClick={onCreateOverride}>
                    Create override
                  </Button>
                )}
              </div>
            </div>

            {selected.details?.image && (
              <Caption1 className={styles.summary}>{`Image: ${selected.details.image}`}</Caption1>
            )}
            {selected.details?.services && selected.details.services.length > 0 && (
              <Caption1 className={styles.summary}>{`Services: ${selected.details.services.join(', ')}`}</Caption1>
            )}
            {selected.details?.runAs && (
              <Caption1 className={styles.summary}>{`Runs as: ${selected.details.runAs}`}</Caption1>
            )}
            {selected.details?.confine !== undefined && (
              <Caption1 className={styles.summary}>{`Confined: ${selected.details.confine ? 'yes' : 'no'}`}</Caption1>
            )}

            {selected.origin === 'user-override' && selected.path && (
              <div className={styles.pathRow}>
                <Caption1 className={styles.pathText}>{selected.path}</Caption1>
                <Button size="sm" variant="ghost" onClick={onCopyPath}>
                  {copied ? 'Copied' : 'Copy path'}
                </Button>
                {canReveal && (
                  <Button size="sm" variant="ghost" onClick={onReveal}>
                    Reveal
                  </Button>
                )}
              </div>
            )}

            {createdPath && <Caption1 className={styles.summary}>{`Override created at ${createdPath}`}</Caption1>}
            {actionError && <Caption1 className={styles.error}>{actionError}</Caption1>}

            {yaml !== null ? (
              <pre className={styles.yaml}>{yaml}</pre>
            ) : (
              <Caption1 className={styles.summary}>
                {selected.origin === 'implicit'
                  ? 'Built into omni serve — no YAML file backs this profile.'
                  : 'Loading YAML…'}
              </Caption1>
            )}
          </div>
        </Card>
      )}
    </div>
  );
});
ProfilesPane.displayName = 'ProfilesPane';
