import { memo, useCallback, useEffect, useState } from 'react';
import { PiCaretDownBold, PiCaretRightBold, PiRobotBold, PiTerminalBold, PiUserBold } from 'react-icons/pi';

import { Spinner } from '@/renderer/ds';
import type { FleetSessionMessage } from '@/shared/types';

import { fleetApi } from './state';

const ToolCallMessage = memo(({ message }: { message: FleetSessionMessage }) => {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg cursor-pointer"
        onClick={toggle}
      >
        {expanded ? <PiCaretDownBold size={10} /> : <PiCaretRightBold size={10} />}
        <PiTerminalBold size={12} />
        <span className="font-medium">{message.toolName}</span>
      </button>
      {expanded && (
        <pre className="text-xs text-fg-muted bg-surface-raised rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
          {message.content}
        </pre>
      )}
    </div>
  );
});
ToolCallMessage.displayName = 'ToolCallMessage';

const ToolResultMessage = memo(({ message }: { message: FleetSessionMessage }) => {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg cursor-pointer"
        onClick={toggle}
      >
        {expanded ? <PiCaretDownBold size={10} /> : <PiCaretRightBold size={10} />}
        <span className="text-[10px]">Result</span>
      </button>
      {expanded && (
        <pre className="text-xs text-fg-muted bg-surface-raised rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
          {message.content}
        </pre>
      )}
    </div>
  );
});
ToolResultMessage.displayName = 'ToolResultMessage';

export const FleetSessionHistory = memo(({ sessionId }: { sessionId: string }) => {
  const [messages, setMessages] = useState<FleetSessionMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fleetApi
      .getSessionHistory(sessionId)
      .then((result) => {
        if (!cancelled) {
          setMessages(result);
        }
      })
      .catch(() => {
        // silently fail
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 w-full h-full">
        <Spinner size="lg" />
        <span className="text-sm text-fg-muted">Loading session history...</span>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 w-full h-full">
        <span className="text-sm text-fg-muted">No conversation history found</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4 overflow-y-auto h-full">
      {messages.map((msg) => {
        if (msg.role === 'tool_call') {
          return <ToolCallMessage key={msg.id} message={msg} />;
        }
        if (msg.role === 'tool_result') {
          return <ToolResultMessage key={msg.id} message={msg} />;
        }

        const isUser = msg.role === 'user';
        return (
          <div key={msg.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-xs text-fg-muted">
              {isUser ? <PiUserBold size={12} /> : <PiRobotBold size={12} />}
              <span className="font-medium">{isUser ? 'User' : 'Assistant'}</span>
            </div>
            <div
              className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                isUser ? 'bg-surface-raised text-fg-muted' : 'bg-accent-400/10 text-fg'
              }`}
            >
              {msg.content}
            </div>
          </div>
        );
      })}
    </div>
  );
});
FleetSessionHistory.displayName = 'FleetSessionHistory';
