import './DiffView.css';

import { ChevronRightIcon, SquareArrowOutUpRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { ThemedToken } from 'shiki';

import { cn } from '@/renderer/ds/cn';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/ds/ui/collapsible';
import { highlightCode, type TokenizedCode, TokenSpan } from '@/renderer/omniagents-ui/components/ai/code-block';

import { type ChangeBadge, type DiffLine, languageForPath } from './diff-model';

/**
 * Diff presentation shared by the Git and Review sidecar apps: numbered,
 * Shiki-highlighted diff lines inside sticky, collapsible per-file
 * sections. Pure presentation — data loading and actions stay with the
 * owning surface.
 */

function isContentLine(line: DiffLine): boolean {
  return line.kind === 'add' || line.kind === 'delete' || line.kind === 'context';
}

/**
 * Shiki tokens for a section's content lines, or null while pending / for
 * unhighlightable files. Content lines (adds, deletes, context) are
 * joined in order and tokenized as one block so multi-line constructs
 * highlight correctly, then mapped back one-to-one by line index.
 */
export function useDiffTokens(path: string, lines: DiffLine[], enabled = true): ThemedToken[][] | null {
  const language = useMemo(() => languageForPath(path), [path]);
  const code = useMemo(
    () =>
      lines
        .filter(isContentLine)
        .map((line) => line.content)
        .join('\n'),
    [lines]
  );
  const [tokenized, setTokenized] = useState<TokenizedCode | null>(null);
  useEffect(() => {
    if (!enabled || !language || code === '') {
      setTokenized(null);
      return;
    }
    let alive = true;
    const immediate = highlightCode(code, language, (result) => {
      if (alive) {
        setTokenized(result);
      }
    });
    setTokenized(immediate);
    return () => {
      alive = false;
    };
  }, [enabled, language, code]);
  return tokenized?.tokens ?? null;
}

export function DiffLines({ lines, tokens }: { lines: DiffLine[]; tokens: ThemedToken[][] | null }) {
  // nth content line ↔ nth tokenized line; separators/notes carry no code.
  const tokenIndexByLine = useMemo(() => {
    let next = 0;
    return lines.map((line) => (isContentLine(line) ? next++ : null));
  }, [lines]);
  return (
    <pre className="omni-diff-lines m-0 font-mono text-xs" aria-label="Diff lines">
      {lines.map((line, index) => {
        const tokenIndex = tokenIndexByLine[index];
        const lineTokens = tokenIndex !== null && tokenIndex !== undefined ? tokens?.[tokenIndex] : undefined;
        return (
          <span
            key={index}
            className={cn(
              'grid grid-cols-[3.5rem_1rem_minmax(max-content,1fr)] whitespace-pre',
              line.kind === 'add' && 'bg-success/10',
              line.kind === 'delete' && 'bg-destructive/10',
              (line.kind === 'separator' || line.kind === 'note') && 'text-muted-foreground'
            )}
          >
            <span className="pr-2 text-right text-muted-foreground" aria-hidden="true">
              {line.newLineno ?? (line.kind === 'separator' ? '⋯' : '')}
            </span>
            <span aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '}</span>
            <span>
              {lineTokens && lineTokens.length > 0
                ? lineTokens.map((token, tokenIdx) => <TokenSpan key={tokenIdx} token={token} />)
                : line.content}
            </span>
          </span>
        );
      })}
    </pre>
  );
}

export function Counts({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions === null && deletions === null) {
    return null;
  }
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-xs">
      {additions !== null && <span className="text-success">+{additions}</span>}{' '}
      {deletions !== null && <span className="text-destructive">−{deletions}</span>}
    </span>
  );
}

export type DiffSectionProps = {
  path: string;
  badge: ChangeBadge;
  additions: number | null;
  deletions: number | null;
  /** Capture caveats rendered as header chips ("opaque", "no baseline"). */
  notes?: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFile?: () => void;
  /** Extra header controls (stage/unstage/discard) after the open action. */
  headerActions?: ReactNode;
  children: ReactNode;
};

/** One file in the stream: a sticky, clickable header (chevron, change
 *  badge, path, counts, caveat chips, actions) over collapsible content. */
export function DiffSection({
  path,
  badge,
  additions,
  deletions,
  notes = [],
  open,
  onOpenChange,
  onOpenFile,
  headerActions,
  children,
}: DiffSectionProps) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="group/file border-b border-border"
      data-diff-file={path}
    >
      <div className="sticky top-0 z-10 flex items-center gap-1 bg-card px-2 py-1">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-accent/50"
            aria-label={`${open ? 'Collapse' : 'Expand'} diff for ${path}`}
          >
            <ChevronRightIcon
              className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/file:rotate-90"
              aria-hidden
            />
            <span className={cn('shrink-0 font-mono text-xs font-semibold', badge.className)} title={badge.title}>
              {badge.text}
            </span>
            <span className="min-w-0 truncate font-mono text-xs font-medium text-foreground" title={path}>
              {path}
            </span>
            <Counts additions={additions} deletions={deletions} />
            {notes.map((note) => (
              <Badge key={note} variant="outline" className="shrink-0 px-1 py-0 text-[10px] font-normal text-warning">
                {note}
              </Badge>
            ))}
          </button>
        </CollapsibleTrigger>
        {onOpenFile ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            title={`Open ${path}`}
            aria-label={`Open ${path}`}
            onClick={onOpenFile}
          >
            <SquareArrowOutUpRightIcon className="size-3.5" />
          </Button>
        ) : null}
        {headerActions}
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
