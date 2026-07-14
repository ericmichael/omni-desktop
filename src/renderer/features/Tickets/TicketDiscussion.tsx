import { makeStyles, tokens } from '@fluentui/react-components';
import { Bot20Regular, Person20Regular, Send20Regular } from '@fluentui/react-icons';
import { nanoid } from 'nanoid';
import { memo, useCallback, useState } from 'react';

import { formatTimestamp } from '@/lib/format-time';
import { IconButton, Textarea } from '@/renderer/ds';
import type { Ticket, TicketComment } from '@/shared/types';

import { ticketApi } from './state';

/**
 * The ticket's comment thread, inlined under the description in the Overview
 * (the GitHub issue shape) — comments flow with the page scroll and the
 * composer sits at the end of the thread.
 */
const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  empty: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
  },
  comment: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
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
  composer: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalS,
  },
  composerField: {
    flex: '1 1 0',
    minWidth: 0,
  },
});

const CommentRow = memo(({ comment }: { comment: TicketComment }) => {
  const styles = useStyles();
  const isAgent = comment.author === 'agent';

  return (
    <div className={styles.comment}>
      <div className={`${styles.avatar} ${isAgent ? styles.avatarAgent : styles.avatarHuman}`}>
        {isAgent ? (
          <Bot20Regular style={{ width: 16, height: 16 }} />
        ) : (
          <Person20Regular style={{ width: 16, height: 16 }} />
        )}
      </div>
      <div className={styles.commentBody}>
        <div className={styles.commentMeta}>
          <span className={styles.commentAuthor}>{isAgent ? 'Agent' : 'You'}</span>
          <span className={styles.commentTime}>{formatTimestamp(comment.createdAt)}</span>
        </div>
        <div className={styles.commentContent}>{comment.content}</div>
      </div>
    </div>
  );
});
CommentRow.displayName = 'CommentRow';

export const TicketDiscussion = memo(({ ticket }: { ticket: Ticket }) => {
  const styles = useStyles();
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
    <div className={styles.root}>
      {comments.length === 0 ? (
        <span className={styles.empty}>No comments yet.</span>
      ) : (
        comments.map((c) => <CommentRow key={c.id} comment={c} />)
      )}

      <div className={styles.composer}>
        <Textarea
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Add a comment..."
          rows={1}
          className={styles.composerField}
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
TicketDiscussion.displayName = 'TicketDiscussion';
