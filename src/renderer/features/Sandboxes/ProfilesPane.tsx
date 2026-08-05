/**
 * Sandboxes → Profiles: the discovered profile catalog. File-backed
 * writable profiles (`origin: 'user-override'` or user-created) are
 * editable in place (v2): a monospace textarea with dirty-tracked
 * Save (`sandbox:write-profile`) / Revert. Builtin-origin profiles stay
 * read-only — "Create override" is the edit path — and the implicit host
 * profile has no file at all. Navigating away while dirty simply drops the
 * draft; a confirm guard is intentionally omitted (keep it simple).
 */

import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/renderer/ds/ui/card';
import { Textarea } from '@/renderer/ds/ui/textarea';
import { $sandboxesError, $sandboxProfiles, refreshSandboxProfiles } from '@/renderer/features/Sandboxes/state';
import { emitter, isCloudLinked, isElectron, isServerLinked, isWslLinked } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ProfileSummary } from '@/shared/types';

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

/** File-backed and user-owned — the only profiles `sandbox:write-profile` accepts. */
const isWritable = (profile: ProfileSummary): boolean =>
  profile.path !== null && (profile.origin === 'user-override' || !profile.builtin);

export const ProfilesPane = memo(() => {
  const profiles = useStore($sandboxProfiles);
  const fetchError = useStore($sandboxesError);
  const store = useStore(persistedStoreApi.$atom);

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [yaml, setYaml] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
    setDraft(null);
    setActionError(null);
    setCreatedPath(null);
    setCopied(false);
    void emitter
      .invoke('sandbox:read-profile', name)
      .then((result) => {
        const text = result?.yaml ?? null;
        setYaml(text);
        setDraft(text);
      })
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

  const onDraftChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
  }, []);

  const onRevert = useCallback(() => {
    setDraft(yaml);
    setActionError(null);
  }, [yaml]);

  const onSave = useCallback(() => {
    if (!selected || draft === null) {
      return;
    }
    setSaving(true);
    setActionError(null);
    void emitter
      .invoke('sandbox:write-profile', selected.name, draft)
      .then(async () => {
        setYaml(draft);
        // The edit may have changed the client type / details — re-discover.
        await refreshSandboxProfiles();
      })
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  }, [selected, draft]);

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
  const writable = selected !== null && isWritable(selected);
  const dirty = yaml !== null && draft !== null && draft !== yaml;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Sandbox profiles</CardTitle>
          <CardDescription>Choose the environments available to projects and agents.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col">
            {profiles.length === 0 && (
              <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
                Discovering profiles…
              </span>
            )}
            {profiles.map((profile) => (
              <Button
                key={profile.name}
                type="button"
                variant="ghost"
                className={cn(
                  'flex items-center gap-4 p-2 rounded-lg cursor-pointer border-0 bg-transparent w-full text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:-outline-offset-2',
                  'h-auto justify-start',
                  profile.name === selectedName && 'bg-accent'
                )}
                onClick={() => selectProfile(profile.name)}
              >
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="text-sm">{profile.label}</span>
                  <span className={cn('text-xs text-muted-foreground', cn('text-muted-foreground', 'font-mono'))}>
                    {profile.name}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {profile.name === defaultName && <Badge variant="secondary">default</Badge>}
                  <Badge variant="secondary">{profile.clientType}</Badge>
                  <Badge variant="secondary">{ORIGIN_LABELS[profile.origin]}</Badge>
                </div>
              </Button>
            ))}
          </div>
          {fetchError && <span className={cn('text-xs text-muted-foreground', 'text-destructive')}>{fetchError}</span>}
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardContent>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="text-sm">{selected.label}</span>
                  {usedByCount > 0 && (
                    <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
                      {`Used by ${usedByCount} ${usedByCount === 1 ? 'project' : 'projects'}`}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
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
                <span
                  className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}
                >{`Image: ${selected.details.image}`}</span>
              )}
              {selected.details?.services && selected.details.services.length > 0 && (
                <span
                  className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}
                >{`Services: ${selected.details.services.join(', ')}`}</span>
              )}
              {selected.details?.runAs && (
                <span
                  className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}
                >{`Runs as: ${selected.details.runAs}`}</span>
              )}
              {selected.details?.confine !== undefined && (
                <span
                  className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}
                >{`Confined: ${selected.details.confine ? 'yes' : 'no'}`}</span>
              )}

              {selected.origin === 'user-override' && selected.path && (
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={cn(
                      'text-xs text-muted-foreground',
                      'font-mono text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap min-w-0'
                    )}
                  >
                    {selected.path}
                  </span>
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

              {createdPath && (
                <span
                  className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}
                >{`Override created at ${createdPath}`}</span>
              )}
              {actionError && (
                <span className={cn('text-xs text-muted-foreground', 'text-destructive')}>{actionError}</span>
              )}

              {yaml !== null ? (
                writable ? (
                  <>
                    <Textarea
                      className="[&_textarea]:font-mono [&_textarea]:text-xs [&_textarea]:whitespace-pre [&_textarea]:overflow-x-auto"
                      value={draft ?? ''}
                      onChange={onDraftChange}
                      aria-label={`YAML for ${selected.name}`}
                    />

                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="default" onClick={onSave} disabled={!dirty || saving}>
                        {saving ? 'Saving…' : 'Save'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={onRevert} disabled={!dirty || saving}>
                        Revert
                      </Button>
                      {dirty && !saving && (
                        <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
                          Unsaved changes
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <pre className="font-mono text-xs bg-card rounded-lg p-2 overflow-x-auto whitespace-pre m-0">
                    {yaml}
                  </pre>
                )
              ) : (
                <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
                  {selected.origin === 'implicit'
                    ? 'Built into omni serve — no YAML file backs this profile.'
                    : 'Loading YAML…'}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
});
ProfilesPane.displayName = 'ProfilesPane';
