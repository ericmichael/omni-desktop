/**
 * ⌘K command palette + the global keyboard map (UI/UX gameplan Phase 4).
 *
 * - mod+K opens the palette: type to filter, ↑/↓ to move, Enter to run,
 *   Esc to close.
 * - mod+1…9 jump straight to the Nth deck column (and switch to Spaces),
 *   palette closed or open.
 *
 * Mounted once at the app root, renders nothing until opened.
 */
import './CommandPalette.css';

import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';
import { memo, useCallback, useMemo, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { Button } from '@/renderer/ds/ui/button';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/renderer/ds/ui/command';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import { Field, FieldLabel } from '@/renderer/ds/ui/field';
import { Input } from '@/renderer/ds/ui/input';
import { codeApi } from '@/renderer/features/Code/state';
import { $quickCaptureOpen } from '@/renderer/features/Inbox/QuickCapture';
import { goToInbox } from '@/renderer/features/Inbox/state';
import { goToRoutine } from '@/renderer/features/ScheduledTasks/state';
import { ticketApi } from '@/renderer/features/Tickets/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTab, LayoutMode } from '@/shared/types';

import { buildCommands, filterCommands, paletteColumns } from './commands';

const HOTKEY_OPTS = { enableOnFormTags: true, preventDefault: true } as const;

/**
 * Whether the palette is open. An atom (not component state) so other
 * surfaces can summon it — Home's jump box is a visible alias for ⌘K.
 */
export const $commandPaletteOpen = atom(false);

export const CommandPalette = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const open = useStore($commandPaletteOpen);
  const [query, setQuery] = useState('');
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [projectName, setProjectName] = useState('');

  const navigate = useCallback((mode: LayoutMode) => {
    persistedStoreApi.setKey('layoutMode', mode);
  }, []);

  const activateColumn = useCallback((tabId: string) => {
    codeApi.setActiveTab(tabId);
    persistedStoreApi.setKey('layoutMode', 'chat');
  }, []);

  const handleGoToInbox = useCallback(() => {
    goToInbox();
  }, []);

  const handleGoToRoutines = useCallback(() => {
    goToRoutine();
  }, []);

  const addInboxItem = useCallback(() => {
    $quickCaptureOpen.set(true);
  }, []);

  const createProject = useCallback(() => {
    setProjectName('');
    setCreateProjectOpen(true);
  }, []);

  const handleCreateProject = useCallback(() => {
    const label = projectName.trim();
    if (!label) {
      return;
    }
    const slug =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'project';
    void ticketApi.addProject({ label, slug, sources: [] }).then((project) => {
      // goToProject raises the Work rail tab itself.
      ticketApi.goToProject(project.id);
    });
    setCreateProjectOpen(false);
  }, [projectName]);

  const resolveTabLabel = useCallback(
    (tab: CodeTab) => {
      const project = store.projects.find((p) => p.id === tab.projectId);
      if (project) {
        return tab.ticketTitle ? `${project.label} — ${tab.ticketTitle}` : project.label;
      }
      return 'New Session';
    },
    [store.projects]
  );

  const commands = useMemo(
    () =>
      buildCommands({
        codeTabs: store.codeTabs ?? [],
        codeLayoutMode: store.codeLayoutMode,
        resolveTabLabel,
        navigate,
        activateColumn,
        goToInbox: handleGoToInbox,
        goToRoutines: handleGoToRoutines,
        addInboxItem,
        createProject,
        newSession: () => {
          void codeApi.addTab();
          persistedStoreApi.setKey('layoutMode', 'chat');
        },
        setDeckLayout: (mode) => {
          codeApi.setLayoutMode(mode);
          persistedStoreApi.setKey('layoutMode', 'chat');
        },
      }),
    [
      store.codeTabs,
      store.codeLayoutMode,
      resolveTabLabel,
      navigate,
      activateColumn,
      handleGoToInbox,
      handleGoToRoutines,
      addInboxItem,
      createProject,
    ]
  );

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  const close = useCallback(() => {
    $commandPaletteOpen.set(false);
    setQuery('');
  }, []);

  const runCommand = useCallback(
    (command: (typeof filtered)[number]) => {
      close();
      command.run();
    },
    [close]
  );

  useHotkeys('mod+k', () => $commandPaletteOpen.set(!$commandPaletteOpen.get()), HOTKEY_OPTS, []);

  // mod+1…9: jump to the Nth deck column directly.
  useHotkeys(
    'mod+1,mod+2,mod+3,mod+4,mod+5,mod+6,mod+7,mod+8,mod+9',
    (e) => {
      const digit = Number(e.key);
      if (!Number.isInteger(digit) || digit < 1) {
        return;
      }
      const columns = paletteColumns(persistedStoreApi.getKey('codeTabs') ?? []);
      const target = columns[digit - 1];
      if (target) {
        activateColumn(target.id);
      }
    },
    HOTKEY_OPTS,
    [activateColumn]
  );

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={(nextOpen) => !nextOpen && close()}
        title="Command palette"
        description="Search launcher navigation and actions"
        className="omni-command-palette-dialog max-w-140 translate-y-0"
        showCloseButton={false}
      >
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Type a command…"
          aria-label="Search commands"
        />
        <CommandList>
          <CommandEmpty>No matching commands</CommandEmpty>
          <CommandGroup>
            {filtered.map((cmd) => (
              <CommandItem key={cmd.id} value={`${cmd.label} ${cmd.keywords ?? ''}`} onSelect={() => runCommand(cmd)}>
                <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                {cmd.hint && <CommandShortcut>{cmd.hint}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      <Dialog open={createProjectOpen} onOpenChange={setCreateProjectOpen}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              handleCreateProject();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create project</DialogTitle>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="command-palette-project-name">Project name</FieldLabel>
              <Input
                id="command-palette-project-name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                autoFocus
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateProjectOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!projectName.trim()}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
});
CommandPalette.displayName = 'CommandPalette';
