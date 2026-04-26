import { BookmarkIcon, CodeIcon, FileTextIcon, GlobeIcon, SendHorizontalIcon } from 'lucide-react';
import { memo, useState } from 'react';

import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
  Checkpoint,
  CheckpointIcon,
  CheckpointTrigger,
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
  Plan,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanFooter,
  PlanHeader,
  PlanTitle,
  PlanTrigger,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  Shimmer,
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
  Suggestion,
  Suggestions,
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/renderer/omniagents-ui/components/ai';
import type { ToolState } from '@/renderer/omniagents-ui/ai-types';
import { Button } from '@/renderer/omniagents-ui/components/ui/button';
import { TooltipProvider } from '@/renderer/omniagents-ui/components/ui/tooltip';
import {
  PromptInput,
  PromptInputActions,
  PromptInputTextarea,
} from '@/renderer/omniagents-ui/components/promptkit/PromptInput';
import { Markdown } from '@/renderer/omniagents-ui/components/promptkit/markdown';

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-12">
    <h2 className="mb-4 border-b border-border pb-2 text-lg font-semibold text-foreground">{title}</h2>
    <div className="flex flex-col gap-6">{children}</div>
  </section>
);

const Variant = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
    {children}
  </div>
);

const SAMPLE_MD = `# Hello
This is **markdown** with a \`code\` span and a [link](https://example.com).

\`\`\`ts
const greet = (name: string) => \`hi \${name}\`;
\`\`\`

- item one
- item two
`;

const TOOL_STATES: { state: ToolState; label: string }[] = [
  { state: 'input-streaming', label: 'input-streaming' },
  { state: 'input-available', label: 'input-available' },
  { state: 'approval-requested', label: 'approval-requested' },
  { state: 'output-available', label: 'output-available' },
  { state: 'output-error', label: 'output-error' },
  { state: 'output-denied', label: 'output-denied' },
];

export const Gallery = memo(() => {
  const [promptValue, setPromptValue] = useState('');

  return (
    <TooltipProvider>
      <div className="h-full w-full overflow-auto bg-background p-8 text-foreground">
        <div className="mx-auto max-w-3xl">
        <header className="mb-8">
          <h1 className="text-2xl font-bold">Component Gallery</h1>
          <p className="text-sm text-muted-foreground">
            Dev-only kitchen sink for chat UI components. Add fixtures here when you add or change a component.
          </p>
        </header>

        <Section title="Message">
          <Variant label="User">
            <Message from="user">
              <MessageContent>Can you refactor the auth middleware to use the new session API?</MessageContent>
            </Message>
          </Variant>
          <Variant label="Assistant (streamdown response)">
            <Message from="assistant">
              <MessageContent>
                <MessageResponse>{SAMPLE_MD}</MessageResponse>
              </MessageContent>
            </Message>
          </Variant>
          <Variant label="Assistant with actions">
            <Message from="assistant">
              <MessageContent>Here's the plan, let me know if you want adjustments.</MessageContent>
              <MessageActions>
                <MessageAction tooltip="Copy">
                  <CodeIcon className="size-3.5" />
                </MessageAction>
                <MessageAction tooltip="Regenerate">
                  <SendHorizontalIcon className="size-3.5" />
                </MessageAction>
              </MessageActions>
            </Message>
          </Variant>
        </Section>

        <Section title="Reasoning">
          <Variant label="Streaming">
            <Reasoning isStreaming defaultOpen>
              <ReasoningTrigger />
              <ReasoningContent>
                {`Let me think about the migration path...\n\n- option A keeps the old middleware\n- option B swaps it out entirely`}
              </ReasoningContent>
            </Reasoning>
          </Variant>
          <Variant label="Completed (duration: 4s)">
            <Reasoning duration={4} defaultOpen>
              <ReasoningTrigger />
              <ReasoningContent>
                {`I chose option B because it removes the dual-write path and simplifies the compliance story.`}
              </ReasoningContent>
            </Reasoning>
          </Variant>
        </Section>

        <Section title="Plan">
          <Variant label="Static">
            <Plan defaultOpen>
              <PlanHeader>
                <div>
                  <PlanTitle>Migrate auth middleware</PlanTitle>
                  <PlanDescription>Rip out legacy session store, wire new JWT path, update tests.</PlanDescription>
                </div>
                <PlanAction>
                  <PlanTrigger />
                </PlanAction>
              </PlanHeader>
              <PlanContent>
                <ol className="list-decimal space-y-1 pl-5 text-sm">
                  <li>Audit callers of `legacyAuth()`</li>
                  <li>Introduce `newAuth()` behind a feature flag</li>
                  <li>Swap call sites in batches of 5</li>
                  <li>Delete legacy path once all callers migrated</li>
                </ol>
              </PlanContent>
              <PlanFooter>
                <Button size="sm">Approve plan</Button>
              </PlanFooter>
            </Plan>
          </Variant>
          <Variant label="Streaming">
            <Plan isStreaming defaultOpen>
              <PlanHeader>
                <div>
                  <PlanTitle>Drafting plan…</PlanTitle>
                  <PlanDescription>Analyzing workspace before proposing steps.</PlanDescription>
                </div>
                <PlanAction>
                  <PlanTrigger />
                </PlanAction>
              </PlanHeader>
            </Plan>
          </Variant>
        </Section>

        <Section title="Task">
          <Task defaultOpen>
            <TaskTrigger title="Searched for session-related files" />
            <TaskContent>
              <TaskItem>
                Looked through <TaskItemFile>src/main/auth.ts</TaskItemFile> and{' '}
                <TaskItemFile>src/shared/session.ts</TaskItemFile>
              </TaskItem>
              <TaskItem>Matched 14 call sites</TaskItem>
            </TaskContent>
          </Task>
        </Section>

        <Section title="Tool (one per state)">
          {TOOL_STATES.map(({ state, label }) => (
            <Variant key={state} label={label}>
              <Tool defaultOpen>
                <ToolHeader
                  type="tool-read_file"
                  state={state}
                  title="read_file"
                  preview="src/main/auth.ts"
                />
                <ToolContent>
                  <ToolInput input={{ path: 'src/main/auth.ts', offset: 0, limit: 100 }} />
                  {state === 'output-available' && (
                    <ToolOutput output={'export const legacyAuth = () => { ... }'} errorText={undefined} />
                  )}
                  {state === 'output-error' && (
                    <ToolOutput output={undefined} errorText={'ENOENT: no such file or directory'} />
                  )}
                </ToolContent>
              </Tool>
            </Variant>
          ))}
        </Section>

        <Section title="Confirmation">
          <Variant label="Pending approval">
            <Confirmation state="approval-requested" approval={{ id: 'c1' }}>
              <ConfirmationRequest>
                <ConfirmationTitle>Allow running `rm -rf dist/` in the workspace?</ConfirmationTitle>
              </ConfirmationRequest>
              <ConfirmationActions>
                <ConfirmationAction variant="secondary">Deny</ConfirmationAction>
                <ConfirmationAction>Approve</ConfirmationAction>
              </ConfirmationActions>
            </Confirmation>
          </Variant>
          <Variant label="Approved">
            <Confirmation state="output-available" approval={{ id: 'c2', approved: true }}>
              <ConfirmationAccepted>
                <ConfirmationTitle>You approved this action.</ConfirmationTitle>
              </ConfirmationAccepted>
            </Confirmation>
          </Variant>
          <Variant label="Rejected">
            <Confirmation state="output-denied" approval={{ id: 'c3', approved: false, reason: 'too risky' }}>
              <ConfirmationRejected>
                <ConfirmationTitle>You denied this action (reason: too risky).</ConfirmationTitle>
              </ConfirmationRejected>
            </Confirmation>
          </Variant>
        </Section>

        <Section title="Artifact">
          <Artifact>
            <ArtifactHeader>
              <div>
                <ArtifactTitle>auth-migration.md</ArtifactTitle>
                <ArtifactDescription>Generated by agent · 2.3 KB</ArtifactDescription>
              </div>
              <ArtifactActions>
                <ArtifactAction tooltip="Open" icon={GlobeIcon} />
                <ArtifactAction tooltip="Download" icon={FileTextIcon} />
              </ArtifactActions>
            </ArtifactHeader>
            <ArtifactContent>
              <MessageResponse>{SAMPLE_MD}</MessageResponse>
            </ArtifactContent>
          </Artifact>
        </Section>

        <Section title="Checkpoint">
          <Checkpoint>
            <CheckpointIcon />
            <CheckpointTrigger tooltip="Restore to this checkpoint">
              <BookmarkIcon className="size-4" />
              Checkpoint · before auth refactor
            </CheckpointTrigger>
          </Checkpoint>
        </Section>

        <Section title="Sources">
          <Sources>
            <SourcesTrigger count={2} />
            <SourcesContent>
              <Source href="https://example.com/rfc-7519" title="RFC 7519 — JWT" />
              <Source href="https://example.com/session-docs" title="Session API docs" />
            </SourcesContent>
          </Sources>
        </Section>

        <Section title="Suggestions">
          <Suggestions>
            <Suggestion suggestion="Summarize this ticket" />
            <Suggestion suggestion="Run the failing test" />
            <Suggestion suggestion="Open the latest PR" />
            <Suggestion suggestion="Explain this stack trace" />
          </Suggestions>
        </Section>

        <Section title="Shimmer">
          <Shimmer>Thinking about your request…</Shimmer>
        </Section>

        <Section title="PromptKit — PromptInput">
          <PromptInput value={promptValue} onValueChange={setPromptValue} onSubmit={() => setPromptValue('')}>
            <PromptInputTextarea placeholder="Ask anything…" />
            <PromptInputActions className="justify-end">
              <Button size="sm">
                <SendHorizontalIcon className="size-3.5" />
              </Button>
            </PromptInputActions>
          </PromptInput>
        </Section>

        <Section title="PromptKit — Markdown">
          <Markdown>{SAMPLE_MD}</Markdown>
        </Section>
        </div>
      </div>
    </TooltipProvider>
  );
});
Gallery.displayName = 'Gallery';
