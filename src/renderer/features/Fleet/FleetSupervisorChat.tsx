import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { PiPaperPlaneRightFill } from 'react-icons/pi';

import { cn } from '@/renderer/ds';
import type { FleetSessionMessage, FleetTicketId } from '@/shared/types';

import { $supervisorMessages, fleetApi } from './state';

const ChatMessage = memo(({ message }: { message: FleetSessionMessage }) => {
  const isUser = message.role === 'user';
  const isToolCall = message.role === 'tool_call';
  const isToolResult = message.role === 'tool_result';

  if (isToolCall) {
    return (
      <div className="flex items-start gap-2 px-3 py-1.5">
        <div className="text-xs text-fg-muted bg-surface-overlay/50 rounded px-2 py-1 font-mono max-w-full overflow-hidden">
          <span className="text-accent-400">{message.toolName}</span>
          {message.content && (
            <span className="text-fg-muted/60 ml-1 truncate">{message.content.slice(0, 100)}</span>
          )}
        </div>
      </div>
    );
  }

  if (isToolResult) {
    return null;
  }

  return (
    <div className={cn('flex px-3 py-2', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words',
          isUser ? 'bg-accent-500/20 text-fg' : 'bg-surface-overlay text-fg'
        )}
      >
        {message.content}
      </div>
    </div>
  );
});
ChatMessage.displayName = 'ChatMessage';

export const FleetSupervisorChat = memo(
  ({ ticketId, supervisorStatus }: { ticketId: FleetTicketId; supervisorStatus?: string }) => {
    const messagesMap = useStore($supervisorMessages);
    const messages = messagesMap[ticketId] ?? [];
    const [input, setInput] = useState('');
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const isRunning = supervisorStatus === 'running';

    // Auto-scroll to bottom on new messages
    useEffect(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, [messages.length]);

    const handleSend = useCallback(() => {
      const trimmed = input.trim();
      if (!trimmed) {
        return;
      }
      void fleetApi.sendSupervisorMessage(ticketId, trimmed);
      setInput('');
      inputRef.current?.focus();
    }, [ticketId, input]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      },
      [handleSend]
    );

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setInput(e.target.value);
    }, []);

    return (
      <div className="flex flex-col h-full">
        {/* Messages */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto py-2">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-fg-muted">
                {supervisorStatus ? 'Waiting for supervisor output...' : 'Send a message to start'}
              </p>
            </div>
          )}
          {messages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
          ))}
        </div>

        {/* Input */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-surface-border shrink-0">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? 'Send a message...' : 'Send a message to continue...'}
            className="flex-1 rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="shrink-0 rounded-md bg-accent-500 p-2 text-white disabled:opacity-40 hover:bg-accent-600 transition-colors cursor-pointer disabled:cursor-default"
          >
            <PiPaperPlaneRightFill size={16} />
          </button>
        </div>
      </div>
    );
  }
);
FleetSupervisorChat.displayName = 'FleetSupervisorChat';
