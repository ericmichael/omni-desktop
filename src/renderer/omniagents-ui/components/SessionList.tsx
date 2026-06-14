import React from 'react';

import { formatRelativeTime, generateSessionTitle } from '@/renderer/omniagents-ui/lib/utils';

export type SessionItem = {
  id: string;
  created_at: string;
  archived: boolean;
  message_count: number;
  first_message?: any;
  last_message?: any;
};

export function SessionList({ sessions, onSelect }: { sessions: SessionItem[]; onSelect: (id?: string) => void }) {
  return (
    <div className="px-3 py-3">
      <div className="text-sm text-textSubtle mb-2">Resume a previous session or start a new one.</div>
      <div className="space-y-2">
        {sessions
          .filter((s) => s.message_count > 0)
          .map((s) => (
            <button
              key={s.id}
              className="w-full text-left px-3 py-2 rounded-md bg-bgCardAlt border border-bgCardAlt hover:brightness-110"
              onClick={() => onSelect(s.id)}
            >
              <div className="text-sm font-medium text-textPrimary truncate">{generateSessionTitle(s)}</div>
              <div className="text-xs text-textSubtle">{formatRelativeTime(s.created_at)}</div>
            </button>
          ))}
        <button
          className="px-3 py-2 rounded-md bg-primary hover:brightness-110 text-primary-foreground"
          onClick={() => onSelect(undefined)}
        >
          Start New Session
        </button>
      </div>
    </div>
  );
}
