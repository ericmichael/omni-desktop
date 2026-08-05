import { useStore } from '@nanostores/react';
import { Bot, Send, User } from 'lucide-react';
import { nanoid } from 'nanoid';
import { memo, useCallback, useState } from 'react';

import { formatTimestamp } from '@/lib/format-time';
import { parseResidentPrincipal } from '@/lib/resident-agent';
import { Avatar, AvatarFallback } from '@/renderer/ds/ui/avatar';
import { Button } from '@/renderer/ds/ui/button';
import { Textarea } from '@/renderer/ds/ui/textarea';
import { persistedStoreApi } from '@/renderer/services/store';
import type { Ticket, TicketComment } from '@/shared/types';

import { ticketApi } from './state';

const CommentRow = memo(({ comment }: { comment: TicketComment }) => {
  // Resident-authored comments carry the agent's principal (`agent:<id>`);
  // resolve it to the roster display name. Plain 'agent' stays the generic
  // task-scoped agent; anything else is the human.
  const residentId = parseResidentPrincipal(comment.author);
  const residents = useStore(persistedStoreApi.$atom).residentAgents;
  const residentName = residentId ? (residents.find((a) => a.id === residentId)?.name ?? residentId) : null;
  const isAgent = comment.author === 'agent' || residentId !== null;

  return (
    <div className="flex gap-2">
      <Avatar className="mt-0.5 size-7">
        <AvatarFallback className={isAgent ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}>
          {isAgent ? <Bot className="size-4" /> : <User className="size-4" />}
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-xs text-foreground">{residentName ?? (isAgent ? 'Agent' : 'You')}</span>
          <span className="text-xs text-muted-foreground">{formatTimestamp(comment.createdAt)}</span>
        </div>
        <div className="max-w-full wrap-anywhere text-sm text-muted-foreground whitespace-pre-wrap leading-5">
          {comment.content}
        </div>
      </div>
    </div>
  );
});
CommentRow.displayName = 'CommentRow';

export const TicketDiscussion = memo(({ ticket }: { ticket: Ticket }) => {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const comments = ticket.comments ?? [];

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
  }, []);

  const handleSend = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending) {
      return;
    }

    const comment: TicketComment = {
      id: nanoid(),
      author: 'human',
      content,
      createdAt: Date.now(),
    };

    setSending(true);
    try {
      await ticketApi.updateTicket(ticket.id, {
        comments: [...(ticket.comments ?? []), comment],
      });
      setDraft('');
    } finally {
      setSending(false);
    }
  }, [draft, sending, ticket]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className="flex flex-col min-w-0 max-w-full gap-4">
      {comments.length === 0 ? (
        <span className="text-xs text-muted-foreground italic">No comments yet.</span>
      ) : (
        comments.map((c) => <CommentRow key={c.id} comment={c} />)
      )}

      <div className="flex items-end gap-2">
        <Textarea
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Add a comment..."
          rows={1}
          className="flex-1 min-w-0"
        />

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Send comment"
          onClick={handleSend}
          disabled={!draft.trim() || sending}
        >
          <Send />
        </Button>
      </div>
    </div>
  );
});
TicketDiscussion.displayName = 'TicketDiscussion';
