import { makeStyles } from '@fluentui/react-components';
import { memo, useEffect, useState } from 'react';

import { columnLabelFor } from '@/renderer/services/agent-attention';
import { $columnActivity, type ColumnActivity } from '@/renderer/services/column-activity';
import { buildAnnouncements } from '@/renderer/services/status-announcer';

/** Announcements landing within this window read as one utterance. */
const COALESCE_MS = 1000;
/** Clear afterwards so an identical later announcement re-fires. */
const CLEAR_MS = 5000;

const useStyles = makeStyles({
  visuallyHidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    border: 'none',
  },
});

/**
 * The screen-reader status center: one polite live region for all column
 * transitions ("Launcher: finished · Omni Ecosystem: waiting for your
 * approval"). Mounted once at the App root.
 */
export const StatusAnnouncer = memo(() => {
  const styles = useStyles();
  const [text, setText] = useState('');

  useEffect(() => {
    let prev: Record<string, ColumnActivity> = { ...$columnActivity.get() };
    let queue: string[] = [];
    let flushTimer: number | null = null;
    let clearTimer: number | null = null;

    const flush = () => {
      flushTimer = null;
      if (queue.length === 0) {
        return;
      }
      setText(queue.join(' · '));
      queue = [];
      if (clearTimer !== null) {
        window.clearTimeout(clearTimer);
      }
      clearTimer = window.setTimeout(() => setText(''), CLEAR_MS);
    };

    const unsubscribe = $columnActivity.listen((next) => {
      const messages = buildAnnouncements(prev, next, columnLabelFor);
      prev = { ...next };
      if (messages.length > 0) {
        queue.push(...messages);
        if (flushTimer === null) {
          flushTimer = window.setTimeout(flush, COALESCE_MS);
        }
      }
    });

    return () => {
      unsubscribe();
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
      }
      if (clearTimer !== null) {
        window.clearTimeout(clearTimer);
      }
    };
  }, []);

  return (
    <div role="status" aria-live="polite" className={styles.visuallyHidden}>
      {text}
    </div>
  );
});
StatusAnnouncer.displayName = 'StatusAnnouncer';
