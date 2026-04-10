import { memo, useCallback, useRef, useState } from 'react';
import { Send20Regular, Bot20Regular, Person20Regular } from '@fluentui/react-icons';
import { makeStyles, tokens } from '@fluentui/react-components';
import { nanoid } from 'nanoid';

import { Body1, IconButton, Textarea } from '@/renderer/ds';
import type { Ticket, TicketComment } from '@/shared/types';

import { ticketApi } from './state';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  thread: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    padding: tokens.spacingVerticalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  empty: {
    flex: '1 1 0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorNeutralForeground3,
  },
  comment: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    maxWidth: '42rem',
  },
  avatar: {
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: '2px',
  },
  avatarAgent: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
  },
  avatarHuman: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  commentBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
  },
  commentMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  commentAuthor: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
  },
  commentTime: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  commentContent: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
    lineHeight: tokens.lineHeightBase300,
  },
  inputBar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalS,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens.colorNeutralStroke1,
    flexShrink: 0,
  },
  inputField: {
    flex: '1 1 0',
    minWidth: 0,
  },
});

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (isToday) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

const CommentRow = memo(({ comment }: { comment: TicketComment }) => {
  const styles = useStyles();
  const isAgent = comment.author === 'agent';

  return (
    <div className={styles.comment}>
      <div className={`${styles.avatar} ${isAgent ? styles.avatarAgent : styles.avatarHuman}`}>
        {isAgent ? <Bot20Regular style={{ width: 16, height: 16 }} /> : <Person20Regular style={{ width: 16, height: 16 }} />}
      </div>
      <div className={styles.commentBody}>
        <div className={styles.commentMeta}>
          <span className={styles.commentAuthor}>{isAgent ? 'Agent' : 'You'}</span>
          <span className={styles.commentTime}>{formatTime(comment.createdAt)}</span>
        </div>
        <div className={styles.commentContent}>{comment.content}</div>
      </div>
    </div>
  );
});
CommentRow.displayName = 'CommentRow';

export const TicketDiscussionTab = memo(({ ticket }: { ticket: Ticket }) => {
  const styles = useStyles();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const comments = ticket.comments ?? [];

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
  }, []);

  const handleSend = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending) return;

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
      // Scroll to bottom after new comment
      requestAnimationFrame(() => {
        threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
      });
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
    <div className={styles.root}>
      {comments.length === 0 ? (
        <div className={styles.empty}>
          <Body1>No comments yet</Body1>
        </div>
      ) : (
        <div ref={threadRef} className={styles.thread}>
          {comments.map((c) => (
            <CommentRow key={c.id} comment={c} />
          ))}
        </div>
      )}

      <div className={styles.inputBar}>
        <Textarea
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Add a comment..."
          rows={1}
          className={styles.inputField}
        />
        <IconButton
          aria-label="Send comment"
          icon={<Send20Regular />}
          size="sm"
          onClick={handleSend}
          isDisabled={!draft.trim() || sending}
        />
      </div>
    </div>
  );
});
TicketDiscussionTab.displayName = 'TicketDiscussionTab';
