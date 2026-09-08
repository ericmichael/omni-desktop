import { beforeEach, expect, it, vi } from 'vitest';

import { conversationDrafts, getConversationDraft, updateConversationDraft } from './conversation-drafts';
import { prepareConversation } from './prepare-conversation';
import type { RPCClient } from './rpc/client';

beforeEach(() => conversationDrafts.set({}));

it('applies draft choices in order without a session.ensure request', async () => {
  const calls: string[] = [];
  const client = {
    request: vi.fn(async (method: string) => {
      calls.push(method);
      return method === 'set_session_model'
        ? {
            ok: true,
            session_id: 'a',
            model: 'provider/model',
            label: 'Model',
            provider: 'provider',
            max_input_tokens: 100,
            max_output_tokens: 10,
            reasoning_effort: 'medium',
            warnings: [],
          }
        : { ok: true, session_id: 'a', reasoning_effort: 'high', model: 'provider/model' };
    }),
    setSessionApprovals: vi.fn(async () => {
      calls.push('approvals');
      return { ok: true };
    }),
    setSessionWorkflow: vi.fn(async () => {
      calls.push('workflow');
      return { ok: true };
    }),
  } as unknown as RPCClient;
  updateConversationDraft('a', {
    text: 'keep draft',
    model: 'provider/model',
    reasoning: 'high',
    approvals: 'auto',
    workflow: 'off',
  });
  await prepareConversation(client, 'a');
  expect(calls).toEqual(['set_session_model', 'set_session_reasoning', 'approvals', 'workflow']);
  expect(getConversationDraft('a').text).toBe('keep draft');
  expect(getConversationDraft('a').model).toBeUndefined();
});

it('retains choices if the server refuses them so the first prompt cannot silently use defaults', async () => {
  updateConversationDraft('a', { model: 'unavailable' });
  const client = { request: vi.fn(async () => ({ ok: false, reasons: [] })) } as unknown as RPCClient;
  await expect(prepareConversation(client, 'a')).rejects.toThrow('Could not apply');
  expect(getConversationDraft('a').model).toBe('unavailable');
});
