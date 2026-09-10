import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CanonicalItemEnvelope,
  GuardianReviewItem,
  MessageItem,
  ReasoningItem,
  ToolItem,
  WorkflowReviewItem,
} from '@/shared/chat-types';

import { ApprovalCard, MessageList } from './MessageList';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const envelope = (id: string, overrides: Partial<CanonicalItemEnvelope> = {}): CanonicalItemEnvelope => ({
  item_id: id,
  thread_id: 'thread-1',
  turn_id: null,
  seq: 0,
  kind: 'reasoning',
  status: 'completed',
  revision: 1,
  created_at: 0,
  updated_at: 0,
  content: {},
  source_ref: {},
  ...overrides,
});

it('keeps approval failure local, blocks duplicate clicks, and permits retry', async () => {
  let fail!: (error: Error) => void;
  const a = vi.fn(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      })
  );
  const b = vi.fn();
  await act(async () =>
    root.render(
      <>
        <section id="approval-A">
          <ApprovalCard
            item={{ type: 'approval', request_id: 'A', tool: 'tool-A', argumentsText: '{}' }}
            onDecision={a}
          />
        </section>
        <section id="approval-B">
          <ApprovalCard
            item={{ type: 'approval', request_id: 'B', tool: 'tool-B', argumentsText: '{}' }}
            onDecision={b}
          />
        </section>
      </>
    )
  );
  const approve = [...container.querySelectorAll<HTMLButtonElement>('#approval-A button')].find(
    (button) => button.textContent === 'Approve Once'
  )!;
  act(() => {
    approve.click();
    approve.click();
  });
  expect(a).toHaveBeenCalledOnce();
  expect(approve.disabled).toBe(true);
  await act(async () => fail(new Error('connection lost')));
  // No message: the card simply becomes actionable again.
  expect(container.querySelector('#approval-A [role="alert"]')).toBeNull();
  expect(approve.disabled).toBe(false);
  expect(container.querySelector('#approval-B [role="alert"]')).toBeNull();
  expect(b).not.toHaveBeenCalled();
  a.mockResolvedValueOnce(undefined);
  await act(async () => approve.click());
  expect(a).toHaveBeenCalledTimes(2);
  expect(container.querySelector('#approval-A [role="alert"]')).toBeNull();
});

const workflowReview = (overrides: Partial<WorkflowReviewItem> = {}): WorkflowReviewItem => ({
  type: 'workflow_review',
  task_id: '3',
  subject: 'run tests',
  outcome: 'reject',
  reviewer: 'guardian',
  rationale: 'No test run in the transcript.',
  ...overrides,
});

const guardianReview = (overrides: Partial<GuardianReviewItem> = {}): GuardianReviewItem => ({
  type: 'guardian_review',
  request_id: 'req-1',
  tool: 'bash',
  reviewer: 'guardian',
  outcome: 'allow',
  rationale: 'Safe read-only command.',
  ...overrides,
});

const reasoning = (id: string, summary: string, overrides: Partial<ReasoningItem> = {}): ReasoningItem => ({
  type: 'reasoning',
  summary,
  status: 'completed',
  canonical: envelope(id),
  ...overrides,
});

const tool = (overrides: Partial<ToolItem> = {}): ToolItem => ({
  type: 'tool',
  tool: 'read_file',
  call_id: 'call-1',
  status: 'result',
  input: '{"file_path": "src/a.ts"}',
  output: 'file body here',
  ...overrides,
});

const renderList = async (
  items: MessageItem[],
  extra: { currentRunId?: string; thinking?: boolean; toolStatusText?: string } = {}
) => {
  await act(async () => {
    root.render(
      <MessageList
        items={items}
        currentRunId={extra.currentRunId}
        thinking={extra.thinking}
        toolStatusText={extra.toolStatusText}
      />
    );
    await Promise.resolve();
  });
};

const chains = () => Array.from(container.querySelectorAll('[data-testid="activity-chain"]'));

/** Click the chain's header trigger (the first button inside the block). */
const openChain = async (chain: Element) => {
  await act(async () => (chain.querySelector('button') as HTMLButtonElement).click());
};

describe('MessageList machinery chain', () => {
  it('folds contiguous machinery into a single chain block', async () => {
    await renderList([
      { type: 'chat', role: 'user', content: 'go' },
      reasoning('r1', 'Considering options.'),
      tool({ call_id: 'c1' }),
      workflowReview({ outcome: 'accept_verified' }),
      tool({ call_id: 'c2', tool: 'write_file' }),
      { type: 'chat', role: 'assistant', content: 'done' },
    ]);
    expect(chains()).toHaveLength(1);
    const [chain] = chains();
    await openChain(chain!);
    expect(chain!.querySelectorAll('[data-testid="reasoning-step"]')).toHaveLength(1);
    expect(chain!.querySelectorAll('[data-testid="tool-step"]')).toHaveLength(2);
    expect(chain!.querySelectorAll('[data-testid="workflow-review-step"]')).toHaveLength(1);
  });

  it('renders workflow review outcomes as steps with the right tones — never destructive except rejection', async () => {
    await renderList([
      workflowReview(),
      workflowReview({ task_id: '4', outcome: 'accept_unverified', rationale: 'Only asserted, not shown.' }),
      workflowReview({ task_id: '5', outcome: 'escalated', rationale: 'accepted after repeated disagreement' }),
      workflowReview({ task_id: '6', outcome: 'accept_verified', rationale: 'Test output shown.' }),
    ]);
    const [chain] = chains();
    await openChain(chain!);
    const steps = Array.from(chain!.querySelectorAll('[data-testid="workflow-review-step"]'));
    expect(steps).toHaveLength(4);
    const [rejected, unverified, escalated, verified] = steps;

    expect(rejected!.textContent).toContain("step #3 'run tests' — completion rejected");
    expect(rejected!.querySelector('.text-destructive')).not.toBeNull();
    // The rationale rides along as the step description — no extra click.
    expect(rejected!.textContent).toContain('No test run in the transcript.');

    expect(unverified!.textContent).toContain("step #4 'run tests' — completion accepted (unverified)");
    expect(unverified!.querySelector('.text-warning\\/80')).not.toBeNull();
    expect(unverified!.querySelector('.text-destructive')).toBeNull();

    expect(escalated!.textContent).toContain('completion contested — accepted after repeated disagreement');
    expect(escalated!.querySelector('.text-destructive')).toBeNull();

    expect(verified!.textContent).toContain("step #6 'run tests' — completion verified");
    expect(verified!.querySelector('.text-primary\\/70')).not.toBeNull();
    expect(verified!.querySelector('.text-destructive')).toBeNull();
    expect(verified!.querySelector('.text-warning\\/80')).toBeNull();
  });

  it('renders guardian reviews as shield steps and surfaces denials in the header', async () => {
    await renderList([
      guardianReview(),
      guardianReview({ request_id: 'req-2', tool: 'rm', outcome: 'deny', rationale: 'Destructive command.' }),
    ]);
    const [chain] = chains();
    // Denials stay loud in the collapsed header line.
    const header = chain!.querySelector('button')!;
    expect(header.textContent).toContain('1 rejected');
    expect(header.querySelector('.text-destructive')).not.toBeNull();

    await openChain(chain!);
    const steps = Array.from(chain!.querySelectorAll('[data-testid="guardian-review-step"]'));
    expect(steps).toHaveLength(2);
    const [allowed, denied] = steps;
    expect(allowed!.textContent).toContain('bash approved by guardian');
    expect(allowed!.querySelector('.text-primary\\/70')).not.toBeNull();
    expect(allowed!.querySelector('.text-destructive')).toBeNull();
    expect(denied!.textContent).toContain('rm denied by guardian');
    expect(denied!.querySelector('.text-destructive')).not.toBeNull();
  });

  it('renders no step (and no chain) for terminal reasoning with an empty summary', async () => {
    await renderList([
      { type: 'chat', role: 'user', content: 'hi' },
      reasoning('r-empty', '   '),
      { type: 'chat', role: 'assistant', content: 'hello' },
    ]);
    expect(chains()).toHaveLength(0);

    // …and inside a machinery run it vanishes without breaking the group.
    await renderList([reasoning('r-empty', ''), tool(), reasoning('r-full', 'Thinking it through.')]);
    const [chain] = chains();
    await openChain(chain!);
    expect(chain!.querySelectorAll('[data-testid="reasoning-step"]')).toHaveLength(1);
    expect(chain!.textContent).toContain('Thinking it through.');
  });

  it('reveals the chrome-free tool detail inline when a tool step is clicked', async () => {
    await renderList([tool()]);
    const [chain] = chains();
    await openChain(chain!);
    expect(chain!.querySelector('[data-testid="tool-step-detail"]')).toBeNull();
    const toggle = chain!.querySelector('[data-testid="tool-step-toggle"]') as HTMLButtonElement;
    await act(async () => toggle.click());
    const detail = chain!.querySelector('[data-testid="tool-step-detail"]');
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toContain('file body here');
    // No boxed ToolCard chrome inside the chain — the step label already
    // names the tool and its state.
    expect(chain!.querySelector('[data-slot="tool"]')).toBeNull();
    // Touched-file chip identifies the subject.
    expect(chain!.textContent).toContain('src/a.ts');
    // Toggling again puts the detail away.
    await act(async () => toggle.click());
    expect(chain!.querySelector('[data-testid="tool-step-detail"]')).toBeNull();
  });

  it('folds preamble narration into the chain and keeps the final answer a bubble', async () => {
    const preamble: MessageItem = {
      type: 'chat',
      role: 'assistant',
      content: 'Now let me check the config.',
      canonical: envelope('m1', { kind: 'agent_message', turn_id: 'run-1' }),
    };
    const answer: MessageItem = {
      type: 'chat',
      role: 'assistant',
      content: 'All done — everything passes.',
      canonical: envelope('m2', { kind: 'agent_message', turn_id: 'run-1' }),
    };
    await renderList([
      tool({ call_id: 'c1', runId: 'run-1' }),
      preamble,
      tool({ call_id: 'c2', runId: 'run-1' }),
      answer,
    ]);
    expect(chains()).toHaveLength(1);
    const [chain] = chains();
    await openChain(chain!);
    const step = chain!.querySelector('[data-testid="message-step"]');
    expect(step).not.toBeNull();
    expect(step!.textContent).toContain('Now let me check the config.');
    // The final message is the answer — outside the chain, as a bubble.
    expect(chain!.textContent).not.toContain('All done');
    expect(container.textContent).toContain('All done — everything passes.');
  });

  it('renders live mid-run narration as a bubble, then folds it once a same-run tool follows', async () => {
    // The live shape: MESSAGE_OUTPUT appended by the machine mid-run — a
    // plain chat item stamped with runId, no canonical envelope yet.
    const narration: MessageItem = {
      type: 'chat',
      role: 'assistant',
      content: 'Now let me check the config.',
      runId: 'run-1',
    };
    const before: MessageItem[] = [
      { type: 'chat', role: 'user', content: 'go' },
      tool({ call_id: 'c1', runId: 'run-1' }),
      narration,
    ];
    await renderList(before, { currentRunId: 'run-1', thinking: true });
    // Nothing follows it yet — it streams in as the frontier bubble.
    expect(chains()).toHaveLength(1);
    expect(chains()[0]!.textContent).not.toContain('Now let me check the config.');
    expect(container.textContent).toContain('Now let me check the config.');

    // A same-run tool arrives — the narration folds into the chain.
    await renderList([...before, tool({ call_id: 'c2', runId: 'run-1', status: 'called', output: undefined })], {
      currentRunId: 'run-1',
      thinking: true,
    });
    expect(chains()).toHaveLength(1);
    const [chain] = chains();
    // The chain is running, so it is already auto-open.
    const step = chain!.querySelector('[data-testid="message-step"]');
    expect(step).not.toBeNull();
    expect(step!.textContent).toContain('Now let me check the config.');
    // …and it left the bubble: the text now lives only inside the chain.
    expect(container.querySelectorAll('[data-testid="message-step"]')).toHaveLength(1);
  });

  it('renders a pending-approval tool step as awaiting, not running', async () => {
    const pendingTool = tool({
      call_id: 'c-appr',
      tool: 'execute_bash',
      runId: 'run-1',
      status: 'called',
      output: undefined,
      metadata: { summary: 'Running shell command...' },
    });
    const approval: MessageItem = {
      type: 'approval',
      request_id: 'c-appr',
      tool: 'execute_bash',
      kind: 'function',
    };
    await renderList([pendingTool, approval], { currentRunId: 'run-1', thinking: true });
    const [chain] = chains();
    // Header says what is actually happening: waiting on the user.
    const header = chain!.querySelector('button')!;
    expect(header.textContent).toContain('Awaiting approval…');
    expect(header.textContent).not.toContain('Running shell command');
    // The step names the wait and the tool; the running phrase is withheld.
    const step = chain!.querySelector('[data-testid="tool-step"]')!;
    expect(step.textContent).toContain('Awaiting approval — execute_bash');
    expect(step.textContent).not.toContain('Running shell command');
    // The approval card itself still renders alongside.
    expect(container.textContent).toContain('execute_bash');

    // Without a matching pending approval the step keeps its running phrase.
    await renderList(
      [
        tool({
          call_id: 'c-run',
          runId: 'run-1',
          status: 'called',
          output: undefined,
          metadata: { summary: 'Running shell command...' },
        }),
      ],
      {
        currentRunId: 'run-1',
        thinking: true,
      }
    );
    expect(chains()[0]!.textContent).toContain('Running shell command...');
  });

  it('auto-collapses a clean run after it finishes, but keeps an errored run open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Clean run: streams open, then auto-closes shortly after finishing.
      await renderList([tool({ runId: 'run-1' })], { currentRunId: 'run-1', thinking: true });
      expect(chains()[0]!.querySelectorAll('[data-testid="tool-step"]')).toHaveLength(1);
      await renderList([tool({ runId: 'run-1' })], { currentRunId: 'run-1', thinking: false });
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      expect(chains()[0]!.querySelectorAll('[data-testid="tool-step"]')).toHaveLength(0);

      // Errored run: never auto-collapses.
      act(() => root.unmount());
      root = createRoot(container);
      const failing = tool({
        call_id: 'boom',
        runId: 'run-2',
        metadata: { display_type: 'error', summary: 'exploded' },
      });
      await renderList([failing], { currentRunId: 'run-2', thinking: true });
      await renderList([failing], { currentRunId: 'run-2', thinking: false });
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      const [chain] = chains();
      expect(chain!.querySelectorAll('[data-testid="tool-step"]')).toHaveLength(1);
      expect(chain!.querySelector('button')!.textContent).toContain('1 failed');
    } finally {
      vi.useRealTimers();
    }
  });
});
