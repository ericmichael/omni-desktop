import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useMemo, useState } from 'react';

import { CodeTabContent } from '@/renderer/features/Code/CodeTabContent';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';
import type { AppId } from '@/shared/app-registry';
import { isChatTab } from '@/shared/types';

/**
 * The Chat tab — a full-screen rendering of the reserved chat record in
 * ``codeTabs`` (``CHAT_TAB_ID``), through the same ``CodeTabContent`` that
 * powers every Spaces column. All session behavior (launch lifecycle, profile
 * stickiness, container reattach, switch scrim, dock, voice scope, activity
 * publishing) is the shared column implementation; this wrapper only supplies
 * the full-screen frame and the glass treatment.
 *
 * Chat-mode specifics (per-conversation scratch workspace, ChatShell
 * pre-launch, ``surface: 'chat'`` variables, non-minimal chrome with the
 * Conversations drawer) live behind ``isChatTab`` inside ``CodeTabContent``.
 */

const useStyles = makeStyles({
  fullSizeRelative: { width: '100%', height: '100%', position: 'relative' },
  // Inner surface bg/border colors for chat content come from the Tailwind
  // var overrides pushed at the deck-bg root in MainContent (--color-bgCard,
  // --color-background, etc. resolve to the glass scrim). This class only
  // adds the blur layer to the chat shell, keeps the primary CTA semi-
  // translucent, and rebuilds the chat composer footer as a glass capsule.
  glassRoot: {
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
    '& .bg-primary': {
      backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackground} 70%, transparent)`,
      backdropFilter: 'var(--glass-blur-light)',
      WebkitBackdropFilter: 'var(--glass-blur-light)',
      boxShadow: tokens.shadow8,
    },
    '& .chat-input-footer': {
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: 'transparent',
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
      borderTop: `1px solid var(--colorNeutralStroke1)`,
    },
    '& .chat-input-footer::before': {
      content: '""',
      position: 'absolute',
      top: '12px',
      right: '12px',
      bottom: '12px',
      left: '12px',
      borderRadius: '24px',
      boxShadow: `0 0 0 9999px color-mix(in srgb, ${tokens.colorNeutralBackground1} 30%, transparent)`,
      pointerEvents: 'none',
      zIndex: 0,
    },
    '& .chat-input-footer > *': {
      position: 'relative',
      zIndex: 1,
    },
    '& .chat-input-footer .bg-bgCardAlt': {
      backgroundColor: 'transparent',
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
    },
  },
});

export const Chat = memo(() => {
  const styles = useStyles();
  const initialized = useStore($initialized);
  const store = useStore(persistedStoreApi.$atom);
  const isGlass = !!store.codeDeckBackground;
  // Created by the v26 store migration on boot; null only in the brief window
  // before the migrated store snapshot reaches the renderer.
  const chatTab = useMemo(() => (store.codeTabs ?? []).find(isChatTab) ?? null, [store.codeTabs]);
  const [activeApp, setActiveApp] = useState<AppId>('chat');

  if (!initialized || !chatTab) {
    return null;
  }

  return (
    <div className={mergeClasses(styles.fullSizeRelative, isGlass && styles.glassRoot)}>
      <CodeTabContent
        tab={chatTab}
        isVisible
        activeApp={activeApp}
        onActiveAppChange={setActiveApp}
        isGlass={isGlass}
      />
    </div>
  );
});

Chat.displayName = 'Chat';
