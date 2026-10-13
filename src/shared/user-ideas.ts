import type { UserGoal, UserGoalActor, UserGoalProgress } from './user-goals';

export type UserIdea = {
  id: string;
  goalId: string;
  agentId: string;
  title: string;
  plan: string;
  authorization: string;
  status: 'pending' | 'approved' | 'dismissed';
  feedback: string;
  createdAt: number;
  updatedAt: number;
  progress: UserGoalProgress[];
};
export type UserIdeaCommand =
  | { kind: 'propose'; goalId: string; title: string; plan: string; authorization: string }
  | { kind: 'decide'; id: string; status: 'approved' | 'dismissed'; feedback?: string }
  | { kind: 'progress'; id: string; note: string; reference?: string };

function text(value: unknown, label: string, limit: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > limit)
    throw new Error(`${label} must be ${empty ? '' : 'nonempty '}text of at most ${limit} characters`);
  return value.trim();
}

/** A shared proposal list. The pure mutation reports decision transitions for resident wakeups. */
export function applyUserIdeaCommand(
  current: UserIdea[],
  goals: UserGoal[],
  command: UserIdeaCommand,
  actor: UserGoalActor,
  id: string,
  now: number
): { ideas: UserIdea[]; idea: UserIdea; decisionChanged?: boolean } {
  if (!command || typeof command !== 'object') throw new Error('Invalid idea command');
  const ideas = structuredClone(current);
  if (command.kind === 'propose') {
    if (actor.kind !== 'agent') throw new Error('Proposals require a resident identity');
    if (!goals.some((g) => g.id === command.goalId && g.completedAt === null))
      throw new Error('Open user goal not found');
    if (ideas.length >= 1000) throw new Error('Idea limit reached');
    const idea: UserIdea = {
      id,
      goalId: command.goalId,
      agentId: actor.agentId,
      title: text(command.title, 'Title', 240),
      plan: text(command.plan, 'Plan', 20000),
      authorization: text(command.authorization, 'Authorization', 4000),
      status: 'pending',
      feedback: '',
      createdAt: now,
      updatedAt: now,
      progress: [],
    };
    ideas.unshift(idea);
    return { ideas, idea };
  }
  const idea = ideas.find((i) => i.id === command.id);
  if (!idea) throw new Error('Idea not found');
  if (command.kind === 'decide') {
    if (actor.kind !== 'user') throw new Error('Only the user can approve or dismiss ideas');
    if (!['approved', 'dismissed'].includes(command.status)) throw new Error('Invalid decision');
    if (idea.status !== 'pending') {
      if (idea.status === command.status) return { ideas, idea };
      throw new Error('Idea already decided');
    }
    idea.status = command.status;
    idea.feedback = text(command.feedback ?? '', 'Feedback', 4000, true);
  } else if (command.kind === 'progress') {
    if (actor.kind !== 'agent') throw new Error('Progress requires a resident identity');
    if (idea.status !== 'approved') throw new Error('Only approved ideas accept progress');
    if (idea.progress.length >= 1000) throw new Error('Progress limit reached');
    idea.progress.push({
      id,
      agentId: actor.agentId,
      note: text(command.note, 'Progress', 4000),
      createdAt: now,
      ...(command.reference ? { reference: text(command.reference, 'Reference', 2000) } : {}),
    });
  } else throw new Error('Unknown idea command');
  idea.updatedAt = now;
  return { ideas, idea, decisionChanged: command.kind === 'decide' };
}

export const USER_IDEA_TOOLS = [
  {
    name: 'list_user_ideas',
    description:
      'List proposals and user decisions. Check for duplicates before proposing, and discover approved plans during normal runs. Decision changes notify the proposing resident.',
    parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'get_user_idea',
    description: 'Read a proposal, its authorized scope, user decision, feedback, and progress.',
    parameters: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'propose_user_idea',
    description:
      'Propose a concrete plan to advance an open user goal. State exactly what approval authorizes. Wait for user approval before executing this proposal.',
    parameters: {
      type: 'object' as const,
      properties: {
        goalId: { type: 'string' },
        title: { type: 'string' },
        plan: { type: 'string' },
        authorization: { type: 'string' },
      },
      required: ['goalId', 'title', 'plan', 'authorization'],
    },
  },
  {
    name: 'record_user_idea_progress',
    description:
      'Record progress, a blocker, or a result on an approved idea. Does not complete the goal or trigger work.',
    parameters: {
      type: 'object' as const,
      properties: { id: { type: 'string' }, note: { type: 'string' }, reference: { type: 'string' } },
      required: ['id', 'note'],
    },
  },
];
export const USER_IDEA_TOOL_NAMES: readonly string[] = USER_IDEA_TOOLS.map((t) => t.name);
export const USER_IDEAS_CONTEXT =
  '\n\n## Ideas — user-reviewed proposals\nUse list_user_ideas/get_user_idea to discover decisions and avoid duplicates. Use propose_user_idea for a concrete plan linked to an open goal, with explicit authorization scope. Only the user approves or dismisses. Pending and dismissed plans are not authorized. During normal runs you may advance approved plans within their scope, checking existing progress first and recording progress with record_user_idea_progress. Approval or dismissal wakes the proposing resident to read the decision. Approval does not enable auto-approve, override tool approval rules, or start /goal autopilot. On dismissal, read the feedback and do not execute the dismissed plan. Only the user completes the linked goal.\n';
