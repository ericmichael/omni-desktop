import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { BookmarkIcon, CodeIcon, FileTextIcon, GlobeIcon, SendHorizontalIcon } from 'lucide-react';
import { memo, useState } from 'react';

import type { ToolState } from '@/renderer/omniagents-ui/ai-types';
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
import { ToolCard } from '@/renderer/omniagents-ui/components/MessageList';
import { Markdown } from '@/renderer/omniagents-ui/components/promptkit/markdown';
import {
  PromptInput,
  PromptInputActions,
  PromptInputTextarea,
} from '@/renderer/omniagents-ui/components/promptkit/PromptInput';
import { Button } from '@/renderer/omniagents-ui/components/ui/button';
import { TooltipProvider } from '@/renderer/omniagents-ui/components/ui/tooltip';
import { $glassEnabled } from '@/renderer/theme/use-glass';
import type { ToolItem } from '@/shared/chat-types';

const useStyles = makeStyles({
  // Inner shadcn surface colors (--color-card, --color-muted, --color-secondary, etc.)
  // are overridden to glass scrim values at the deck-bg root in MainContent. This
  // class only adds the blur layer to the page shell and tints the primary CTA.
  glassRoot: {
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
    '& .bg-primary': {
      backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackground} 70%, transparent)`,
      backdropFilter: 'var(--glass-blur-light)',
      WebkitBackdropFilter: 'var(--glass-blur-light)',
      boxShadow: `0 1px 0 0 rgba(255,255,255,0.14) inset, 0 2px 8px -2px rgba(0,0,0,0.15)`,
    },
  },
});

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

// Fixtures for the rich result bodies rendered from ``RichToolOutput.ui_metadata``
// (see renderMetadata in MessageList). Shapes mirror what the omniagents /
// omni-code tools actually emit over the ``tool_result`` event.
const RICH_TOOL_FIXTURES: { label: string; item: ToolItem }[] = [
  {
    label: 'diff (edit_file)',
    item: {
      type: 'tool',
      call_id: 'gallery-diff',
      tool: 'edit_file',
      status: 'result',
      input: JSON.stringify({ file_path: 'src/main/auth.ts', old_text: 'legacyAuth', new_text: 'auth' }),
      output: 'Updated auth.ts - 2 replacement(s)',
      metadata: {
        display_type: 'diff',
        summary: 'Updated auth.ts (2 replacements)',
        value: {
          diff_lines: [
            '--- a/src/main/auth.ts',
            '+++ b/src/main/auth.ts',
            '@@ -12,7 +12,7 @@',
            " import { session } from '@/shared/session';",
            '-export const legacyAuth = () => {',
            '-  return session.verifyCookie();',
            '+export const auth = () => {',
            '+  return session.verifyJwt();',
            ' };',
          ],
        },
        metadata: { file_path: 'src/main/auth.ts', operation: 'edit' },
      },
    },
  },
  {
    label: 'diff (apply_patch — multi-file)',
    item: {
      type: 'tool',
      call_id: 'gallery-apply-patch',
      tool: 'apply_patch',
      status: 'result',
      input: JSON.stringify({
        patch: `*** Begin Patch
*** Update File: src/main/auth.ts
@@ export const legacyAuth
-export const legacyAuth = () => {
-  return session.verifyCookie();
+export const auth = () => {
+  return session.verifyJwt();
 };
*** Add File: src/lib/jwt.ts
+export const signJwt = (payload: object, secret: string) => {
+  return sign(payload, secret, { expiresIn: '1h' });
+};
*** End Patch`,
      }),
      output:
        'Patch applied successfully.\nAdded 1 files:\n  A src/lib/jwt.ts\nModified 1 files:\n  M src/main/auth.ts',
      metadata: {
        display_type: 'diff',
        summary: 'Applied patch (1 adds, 1 updates, 0 deletes) — 2 file(s) changed',
        value: {
          diff_lines: [
            '--- a/src/main/auth.ts',
            '+++ b/src/main/auth.ts',
            '@@ -12,7 +12,7 @@',
            '-export const legacyAuth = () => {',
            '-  return session.verifyCookie();',
            '+export const auth = () => {',
            '+  return session.verifyJwt();',
            ' };',
            '--- /dev/null',
            '+++ b/src/lib/jwt.ts',
            '@@ -0,0 +1,3 @@',
            '+export const signJwt = (payload: object, secret: string) => {',
            "+  return sign(payload, secret, { expiresIn: '1h' });",
            '+};',
          ],
        },
        truncated: false,
        metadata: {
          operation: 'apply_patch',
          file_count: 2,
          additions: 5,
          deletions: 2,
          added_files: ['src/lib/jwt.ts'],
          modified_files: ['src/main/auth.ts'],
          deleted_files: [],
          added_count: 1,
          modified_count: 1,
          deleted_count: 0,
          total_changes: 2,
        },
      },
    },
  },
  {
    label: 'file_write (write_file)',
    item: {
      type: 'tool',
      call_id: 'gallery-file-write',
      tool: 'write_file',
      status: 'result',
      input: JSON.stringify({ file_path: 'src/lib/jwt.ts' }),
      output: 'Created src/lib/jwt.ts (6 lines)',
      metadata: {
        display_type: 'file_write',
        summary: 'Created src/lib/jwt.ts (6 lines)',
        value: `import { sign } from 'jsonwebtoken';

export const signJwt = (payload: object, secret: string) => {
  return sign(payload, secret, { expiresIn: '1h' });
};
`,
        metadata: { file_path: 'src/lib/jwt.ts', operation: 'create', language: 'typescript' },
      },
    },
  },
  {
    label: 'command — success (bash)',
    item: {
      type: 'tool',
      call_id: 'gallery-command-ok',
      tool: 'bash',
      status: 'result',
      input: JSON.stringify({ command: 'npm run lint' }),
      output: 'lint passed',
      metadata: {
        display_type: 'command',
        summary: 'npm run lint',
        value: '> launcher@0.9.0 lint\n> concurrently eslint prettier tsc knip dpdm\n\nAll checks passed.',
        metadata: { command: 'npm run lint', success: true, exit_code: 0, wall_time_ms: 2143 },
      },
    },
  },
  {
    label: 'command — failed (bash)',
    item: {
      type: 'tool',
      call_id: 'gallery-command-fail',
      tool: 'bash',
      status: 'result',
      input: JSON.stringify({ command: 'npm test -- session-filter' }),
      output: 'tests failed',
      metadata: {
        display_type: 'command',
        summary: 'npm test -- session-filter',
        metadata: {
          command: 'npm test -- session-filter',
          success: false,
          exit_code: 1,
          wall_time_ms: 5310,
          stdout: 'FAIL src/lib/session-filter.test.ts\n  ✕ filters expired sessions (12 ms)',
          stderr: 'AssertionError: expected 2 sessions, got 3',
          has_stderr: true,
        },
      },
    },
  },
  {
    label: 'file_content (read_file)',
    item: {
      type: 'tool',
      call_id: 'gallery-file-content',
      tool: 'read_file',
      status: 'result',
      input: JSON.stringify({ file_path: 'src/main/auth.ts', start_line: 1, end_line: 5 }),
      output: 'Read src/main/auth.ts',
      metadata: {
        display_type: 'file_content',
        summary: 'Read src/main/auth.ts (L1-5)',
        preview: `import { session } from '@/shared/session';

export const auth = () => {
  return session.verifyJwt();
};`,
        metadata: { file_path: 'src/main/auth.ts', total_file_lines: 412, start_line: 1, end_line: 5 },
      },
    },
  },
  {
    label: 'directory_listing (list_directory)',
    item: {
      type: 'tool',
      call_id: 'gallery-dir',
      tool: 'list_directory',
      status: 'result',
      input: JSON.stringify({ path: 'src/main' }),
      output: '24 entries',
      metadata: {
        display_type: 'directory_listing',
        summary: 'Listed src/main',
        preview: 'agent-process.ts\nindex.ts\nprocess-manager.ts\nproject-manager.ts\nterminal-proxy.ts\nextensions/',
        metadata: { path: 'src/main', total_entries: 24, file_count: 19, dir_count: 5 },
      },
    },
  },
  {
    label: 'search_results (grep)',
    item: {
      type: 'tool',
      call_id: 'gallery-search',
      tool: 'grep',
      status: 'result',
      input: JSON.stringify({ pattern: 'legacyAuth', path: 'src' }),
      output: '3 files with matches',
      metadata: {
        display_type: 'search_results',
        summary: 'Searched for "legacyAuth"',
        preview:
          'src/main/auth.ts:14:export const legacyAuth = () => {\nsrc/main/index.ts:88:  app.use(legacyAuth());\nsrc/shared/session.ts:31:// TODO: remove once legacyAuth is gone',
        truncated: true,
        metadata: { pattern: 'legacyAuth', files_with_matches: 3, files_searched: 1204, elapsed_ms: 87 },
      },
    },
  },
  {
    label: 'web_content (web_fetch)',
    item: {
      type: 'tool',
      call_id: 'gallery-web',
      tool: 'web_fetch',
      status: 'result',
      input: JSON.stringify({ url: 'https://example.com/rfc-7519' }),
      output: 'Fetched page',
      metadata: {
        display_type: 'web_content',
        summary: 'Fetched https://example.com/rfc-7519',
        preview:
          'JSON Web Token (JWT) is a compact, URL-safe means of representing claims to be transferred between two parties…',
        metadata: {
          title: 'RFC 7519 — JSON Web Token',
          url: 'https://example.com/rfc-7519',
          elapsed_ms: 412,
          link_count: 12,
        },
      },
    },
  },
  {
    label: 'table',
    item: {
      type: 'tool',
      call_id: 'gallery-table',
      tool: 'query_database',
      status: 'result',
      input: JSON.stringify({ sql: 'SELECT * FROM sessions LIMIT 3' }),
      output: '3 rows',
      metadata: {
        display_type: 'table',
        summary: 'Query returned 3 rows',
        table: {
          columns: [{ title: 'id' }, { title: 'user' }, { title: 'expires_at' }],
          rows: [
            ['s_01', 'eric', '2026-07-16T18:00:00Z'],
            ['s_02', 'dana', '2026-07-16T19:30:00Z'],
            ['s_03', 'kai', '2026-07-17T09:15:00Z'],
          ],
        },
      },
    },
  },
  {
    label: 'error',
    item: {
      type: 'tool',
      call_id: 'gallery-error',
      tool: 'read_file',
      status: 'result',
      input: JSON.stringify({ file_path: 'src/main/legacy.ts' }),
      output: 'Error: file not found',
      metadata: {
        display_type: 'error',
        summary: 'File not found: src/main/legacy.ts',
        preview: "ENOENT: no such file or directory, open 'src/main/legacy.ts'",
        metadata: { error_type: 'FileNotFoundError' },
      },
    },
  },
  {
    label: 'unknown display_type — preview fallback',
    item: {
      type: 'tool',
      call_id: 'gallery-fallback',
      tool: 'execute_cell',
      status: 'result',
      input: JSON.stringify({ cell_index: 3 }),
      output: 'Out[3]: 42',
      metadata: {
        display_type: 'notebook',
        summary: 'Executed cell 3',
        preview: 'Out[3]: 42',
      },
    },
  },
];

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
  const styles = useStyles();
  const isGlass = useStore($glassEnabled);

  return (
    <TooltipProvider>
      <div
        className={mergeClasses(
          'h-full w-full overflow-auto p-8 text-foreground',
          !isGlass && 'bg-background',
          isGlass && styles.glassRoot
        )}
      >
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
                <MessageContent>Here&apos;s the plan, let me know if you want adjustments.</MessageContent>
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
                  I chose option B because it removes the dual-write path and simplifies the compliance story.
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
                  <ToolHeader type="tool-read_file" state={state} title="read_file" preview="src/main/auth.ts" />
                  <ToolContent>
                    <ToolInput input={{ path: 'src/main/auth.ts', offset: 0, limit: 100 }} />
                    {state === 'output-available' && (
                      <ToolOutput output="export const legacyAuth = () => { ... }" errorText={undefined} />
                    )}
                    {state === 'output-error' && (
                      <ToolOutput output={undefined} errorText="ENOENT: no such file or directory" />
                    )}
                  </ToolContent>
                </Tool>
              </Variant>
            ))}
          </Section>

          <Section title="Tool — parameters (key-value)">
            <Variant label="Value types: string, multiline string, number, boolean, null, array, nested object">
              <Tool defaultOpen>
                <ToolHeader
                  type="tool-edit_file"
                  state="input-available"
                  title="edit_file"
                  preview="src/main/auth.ts"
                />
                <ToolContent>
                  <ToolInput
                    input={{
                      file_path: 'src/main/auth.ts',
                      old_text: 'export const legacyAuth = () => {\n  return session.verifyCookie();\n};',
                      new_text: 'export const auth = () => {\n  return session.verifyJwt();\n};',
                      expected_replacements: 1,
                      dry_run: false,
                      encoding: null,
                      tags: ['auth', 'refactor'],
                      range: { start_line: 12, end_line: 18 },
                    }}
                  />
                </ToolContent>
              </Tool>
            </Variant>
            <Variant label="Non-object payload — raw JSON fallback">
              <Tool defaultOpen>
                <ToolHeader type="tool-run_batch" state="input-available" title="run_batch" />
                <ToolContent>
                  <ToolInput input={['npm run lint', 'npm test', 'npm run build']} />
                </ToolContent>
              </Tool>
            </Variant>
          </Section>

          <Section title="Tool — rich result bodies (display_type)">
            {RICH_TOOL_FIXTURES.map(({ label, item }) => (
              <Variant key={label} label={label}>
                <ToolCard item={item} defaultOpen />
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
