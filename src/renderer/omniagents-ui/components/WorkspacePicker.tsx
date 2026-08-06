import { ArrowUp, Folder, House } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/ds/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/renderer/ds/ui/input-group';
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/renderer/ds/ui/item';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { useRPCClient } from '@/renderer/omniagents-ui/rpc-context';
import type { ExecutionTarget } from '@/shared/types';

type DirEntry = {
  name: string;
  path: string;
  is_dir: boolean;
};

export function WorkspacePicker({
  sessionId,
  executionTarget,
  initialPath,
  onSelect,
  onClose,
}: {
  sessionId?: string;
  executionTarget?: ExecutionTarget;
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const client = useRPCClient();
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState('');
  const [editingPath, setEditingPath] = useState(false);

  const load = useCallback(
    async (path?: string | null) => {
      setLoading(true);
      setError(null);
      if (!executionTarget) {
        setError('Execution environment unavailable');
        setLoading(false);
        return;
      }
      try {
        const res = (await client.serverCall(
          'fs_list_dir',
          {
            path: path || undefined,
            include_files: false,
            ignore_hidden: true,
          },
          sessionId,
          executionTarget
        )) as any;
        setCurrentPath(res.path || null);
        setParentPath(res.parent || null);
        setManualInput(res.path || '');
        const list: DirEntry[] = [];
        if (Array.isArray(res.entries)) {
          for (const e of res.entries) {
            if (e && typeof e === 'object') {
              list.push({ name: e.name, path: e.path, is_dir: !!e.is_dir });
            }
          }
        }
        setEntries(list);
      } catch (e) {
        setError(String((e as Error)?.message || e));
      } finally {
        setLoading(false);
      }
    },
    [client, executionTarget, sessionId]
  );

  useEffect(() => {
    (async () => {
      // Start at the agent's LIVE working directory — the container manifest
      // root for a sandbox, a host dir for the host target — resolved from the
      // server. This is authoritative over ``initialPath``, which may carry a
      // host project path (store.workspaceDir) that doesn't exist inside a
      // container and would make the (sandbox-aware) lister fail.
      let start: string | undefined;
      try {
        const res = (await client.serverCall('fs_get_workspace_root', {}, sessionId, executionTarget)) as any;
        start = res?.path;
      } catch {}
      if (!start) {
        start = initialPath;
      }
      if (!start) {
        try {
          const res = (await client.serverCall('fs_get_home', {}, sessionId, executionTarget)) as any;
          start = res?.path;
        } catch {}
      }
      await load(start);
    })();
  }, []);

  const handleManualGo = useCallback(() => {
    const trimmed = manualInput.trim();
    if (trimmed) {
      load(trimmed);
      setEditingPath(false);
    }
  }, [manualInput, load]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-dialog flex max-w-lg flex-col gap-0 overflow-hidden p-0">
        {/* Header */}
        <DialogHeader className="px-4 py-3 text-left">
          <DialogTitle className="text-sm">Choose Workspace</DialogTitle>
          <DialogDescription className="sr-only">
            Choose the folder the agent should use as its workspace.
          </DialogDescription>
        </DialogHeader>

        {/* Path bar */}
        <form
          className="border-b border-accent px-4 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            handleManualGo();
          }}
        >
          <InputGroup className="h-8">
            <InputGroupAddon>
              <InputGroupButton
                size="icon-xs"
                onClick={() => parentPath && load(parentPath)}
                disabled={!parentPath}
                aria-label="Go up"
                title="Parent directory"
              >
                <ArrowUp />
              </InputGroupButton>
              <InputGroupButton
                size="icon-xs"
                onClick={async () => {
                  try {
                    const res = (await client.serverCall('fs_get_home', {}, sessionId, executionTarget)) as any;
                    if (res?.path) {
                      load(res.path);
                    }
                  } catch {}
                }}
                aria-label="Home"
                title="Home directory"
              >
                <House />
              </InputGroupButton>
            </InputGroupAddon>
            {editingPath ? (
              <InputGroupInput
                type="text"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                onBlur={() => setEditingPath(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setEditingPath(false);
                  }
                }}
                autoFocus
                className="h-7 text-xs"
              />
            ) : (
              <InputGroupInput
                readOnly
                value={currentPath || '…'}
                className="h-7 cursor-text truncate text-xs"
                onClick={() => setEditingPath(true)}
                title={currentPath || ''}
              />
            )}
          </InputGroup>
        </form>

        {/* Entries list */}
        <ScrollArea className="h-1/2 min-h-0 flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner />
            </div>
          ) : error ? (
            <Empty className="h-full border-0 p-6">
              <EmptyHeader>
                <EmptyTitle>Could not load folders</EmptyTitle>
                <EmptyDescription className="text-destructive">{error}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : entries.length === 0 ? (
            <Empty className="h-full border-0 p-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Folder />
                </EmptyMedia>
                <EmptyTitle>No subdirectories</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup className="p-1">
              {entries.map((entry) => (
                <Item key={entry.path} asChild size="sm" className="w-full cursor-pointer hover:bg-accent">
                  <button type="button" onClick={() => load(entry.path)}>
                    <ItemMedia>
                      <Folder className="text-primary" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle className="truncate">{entry.name}</ItemTitle>
                    </ItemContent>
                  </button>
                </Item>
              ))}
            </ItemGroup>
          )}
        </ScrollArea>

        {/* Footer */}
        <DialogFooter className="border-t px-4 py-3">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={() => currentPath && onSelect(currentPath)} disabled={!currentPath}>
            Use This Folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
