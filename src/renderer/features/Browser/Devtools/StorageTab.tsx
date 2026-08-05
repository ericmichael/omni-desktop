/**
 * Storage tab — cookies, localStorage, sessionStorage for the active tab's
 * origin. Read-only for now beyond per-key delete + per-section clear-all;
 * full edit-cell UX is cheap to add later but not needed v1.
 */
import { RefreshCw, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

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
import { Button } from '@/renderer/ds/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/ds/ui/table';
import { emitter } from '@/renderer/services/ipc';
import type { AppHandleId } from '@/shared/app-control-types';

type Cookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expirationDate?: number;
};

export const StorageTab = memo(({ handleId, activeOrigin }: { handleId: AppHandleId; activeOrigin: string | null }) => {
  const [cookies, setCookies] = useState<Cookie[]>([]);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [session, setSession] = useState<Record<string, string>>({});
  const [pendingClear, setPendingClear] = useState<'cookies' | 'local' | 'session' | null>(null);

  const refresh = useCallback(async () => {
    try {
      const filter = activeOrigin ? { url: activeOrigin } : {};
      const [c, l, s] = await Promise.all([
        emitter.invoke('app:cookies-get', handleId, filter) as Promise<Cookie[]>,
        emitter.invoke('app:storage-get', handleId, 'local'),
        emitter.invoke('app:storage-get', handleId, 'session'),
      ]);
      setCookies(c ?? []);
      setLocal(l ?? {});
      setSession(s ?? {});
    } catch {
      // webview not ready — next refresh
    }
  }, [handleId, activeOrigin]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const deleteCookie = useCallback(
    async (c: Cookie) => {
      const url = activeOrigin ?? `https://${(c.domain ?? '').replace(/^\./, '')}${c.path ?? '/'}`;
      try {
        await emitter.invoke('app:cookies-clear', handleId, { url, name: c.name });
        await refresh();
      } catch {
        // ignore
      }
    },
    [activeOrigin, handleId, refresh]
  );

  const clearCookies = useCallback(async () => {
    const filter = activeOrigin ? { url: activeOrigin } : {};
    try {
      await emitter.invoke('app:cookies-clear', handleId, filter);
      await refresh();
    } catch {
      // ignore
    }
  }, [activeOrigin, handleId, refresh]);

  const clearStorage = useCallback(
    async (which: 'local' | 'session') => {
      try {
        await emitter.invoke('app:storage-clear', handleId, which);
        await refresh();
      } catch {
        // ignore
      }
    },
    [handleId, refresh]
  );

  const confirmClear = useCallback(() => {
    if (pendingClear === 'cookies') {
      void clearCookies();
    } else if (pendingClear) {
      void clearStorage(pendingClear);
    }
  }, [clearCookies, clearStorage, pendingClear]);

  const renderKVTable = (rows: Record<string, string>, onClear: () => void, label: string) => {
    const keys = Object.keys(rows);
    return (
      <div className="flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-card border-b border-border sticky top-0 z-1">
          <span className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">{label}</span>
          <span className="text-xs text-muted-foreground">{keys.length}</span>
          <div className="flex-1" />
          <Button type="button" variant="ghost" size="icon-xs" onClick={onClear} title={`Clear ${label}`}>
            <Trash2 />
          </Button>
        </div>
        {keys.length === 0 ? (
          <div className="px-3 py-4 text-muted-foreground text-xs">No keys.</div>
        ) : (
          <Table className="w-full font-mono text-xs border-collapse">
            <TableHeader>
              <TableRow>
                <TableHead className="text-left px-2 py-0.5 text-xs uppercase text-muted-foreground tracking-wide font-normal border-b border-border sticky top-0 bg-background">
                  Key
                </TableHead>
                <TableHead className="text-left px-2 py-0.5 text-xs uppercase text-muted-foreground tracking-wide font-normal border-b border-border sticky top-0 bg-background">
                  Value
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k}>
                  <TableCell
                    className="px-2 py-0.5 border-b border-muted overflow-hidden text-ellipsis whitespace-nowrap max-w-50"
                    title={k}
                  >
                    {k}
                  </TableCell>
                  <TableCell
                    className={`${'px-2 py-0.5 border-b border-muted overflow-hidden text-ellipsis whitespace-nowrap max-w-50'} ${'text-muted-foreground'}`}
                    title={rows[k]}
                  >
                    {rows[k]}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      {!activeOrigin && (
        <div className="px-3 py-2 text-muted-foreground text-xs">Navigate to a page to see its storage.</div>
      )}
      <div className="flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-card border-b border-border sticky top-0 z-1">
          <span className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">Cookies</span>
          <span className="text-xs text-muted-foreground">{cookies.length}</span>
          <span className="text-xs text-muted-foreground">{activeOrigin ? `— ${activeOrigin}` : ''}</span>
          <div className="flex-1" />
          <Button type="button" variant="ghost" size="icon-xs" onClick={() => void refresh()} title="Refresh">
            <RefreshCw />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setPendingClear('cookies')}
            title="Clear cookies"
          >
            <Trash2 />
          </Button>
        </div>
        {cookies.length === 0 ? (
          <div className="px-3 py-4 text-muted-foreground text-xs">No cookies.</div>
        ) : (
          <Table className="w-full font-mono text-xs border-collapse">
            <TableHeader>
              <TableRow>
                <TableHead className="text-left px-2 py-0.5 text-xs uppercase text-muted-foreground tracking-wide font-normal border-b border-border sticky top-0 bg-background">
                  Name
                </TableHead>
                <TableHead className="text-left px-2 py-0.5 text-xs uppercase text-muted-foreground tracking-wide font-normal border-b border-border sticky top-0 bg-background">
                  Value
                </TableHead>
                <TableHead className="text-left px-2 py-0.5 text-xs uppercase text-muted-foreground tracking-wide font-normal border-b border-border sticky top-0 bg-background">
                  Domain
                </TableHead>
                <TableHead className="text-left px-2 py-0.5 text-xs uppercase text-muted-foreground tracking-wide font-normal border-b border-border sticky top-0 bg-background">
                  Path
                </TableHead>
                <TableHead className="text-left px-2 py-0.5 text-xs uppercase text-muted-foreground tracking-wide font-normal border-b border-border sticky top-0 bg-background">
                  Flags
                </TableHead>
                <TableHead className="text-left px-2 py-0.5 text-xs uppercase text-muted-foreground tracking-wide font-normal border-b border-border sticky top-0 bg-background" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {cookies.map((c, i) => (
                <TableRow key={`${c.domain ?? ''}-${c.path ?? ''}-${c.name}-${i}`}>
                  <TableCell
                    className="px-2 py-0.5 border-b border-muted overflow-hidden text-ellipsis whitespace-nowrap max-w-50"
                    title={c.name}
                  >
                    {c.name}
                  </TableCell>
                  <TableCell
                    className={`${'px-2 py-0.5 border-b border-muted overflow-hidden text-ellipsis whitespace-nowrap max-w-50'} ${'text-muted-foreground'}`}
                    title={c.value}
                  >
                    {c.value}
                  </TableCell>
                  <TableCell className="px-2 py-0.5 border-b border-muted overflow-hidden text-ellipsis whitespace-nowrap max-w-50">
                    {c.domain ?? ''}
                  </TableCell>
                  <TableCell className="px-2 py-0.5 border-b border-muted overflow-hidden text-ellipsis whitespace-nowrap max-w-50">
                    {c.path ?? ''}
                  </TableCell>
                  <TableCell className="px-2 py-0.5 border-b border-muted overflow-hidden text-ellipsis whitespace-nowrap max-w-50">
                    {[c.secure && 'Secure', c.httpOnly && 'HttpOnly', c.sameSite].filter(Boolean).join(' · ')}
                  </TableCell>
                  <TableCell className="w-6 px-1 py-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => void deleteCookie(c)}
                      aria-label={`Delete cookie ${c.name}`}
                      title="Delete cookie"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {renderKVTable(local, () => setPendingClear('local'), 'Local storage')}
      {renderKVTable(session, () => setPendingClear('session'), 'Session storage')}
      <AlertDialog open={pendingClear !== null} onOpenChange={(open) => !open && setPendingClear(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear browser storage?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingClear === 'cookies'
                ? 'Delete all cookies for this origin?'
                : `Clear all ${pendingClear ?? ''}Storage keys?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmClear}>
              Clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
StorageTab.displayName = 'StorageTab';
