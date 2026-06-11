import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type IProjectsRepo, milestoneId, nowTimestamp } from 'omni-projects-db';
import { z } from 'zod';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const });

export function registerMilestoneTools(server: McpServer, repo: IProjectsRepo): void {
  server.tool(
    'list_milestones',
    'List all milestones for a project.',
    { project_id: z.string().describe('The project ID to list milestones for') },
    async ({ project_id }) => {
      const exists = await repo.getProject(project_id);
      if (!exists) return err(`Project not found: ${project_id}`);

      const milestones = await repo.listMilestonesByProject(project_id);

      return json({
        milestones: milestones.map((m) => ({
          id: m.id,
          title: m.title,
          description: m.description,
          branch: m.branch,
          status: m.status,
          due_date: m.due_date,
          completed_at: m.completed_at,
          pinned_at: m.pinned_at,
          created_at: m.created_at,
          updated_at: m.updated_at,
        })),
      });
    }
  );

  server.tool(
    'create_milestone',
    'Create a new milestone (large feature or deliverable) in a project. Tickets can be grouped under milestones.',
    {
      project_id: z.string().describe('The project to create the milestone in'),
      title: z.string().describe('Milestone title'),
      description: z.string().optional().describe('What this milestone delivers'),
      branch: z.string().optional().describe('Optional git branch for this milestone.'),
      due_date: z.string().optional().describe('Optional due date in ISO format (e.g. 2026-04-30).'),
      pinned: z.boolean().optional().describe('Pin the milestone to Home on creation.'),
    },
    async ({ project_id, title, description, branch, due_date, pinned }) => {
      const exists = await repo.getProject(project_id);
      if (!exists) return err(`Project not found: ${project_id}`);

      if (due_date) {
        const parsed = Date.parse(due_date);
        if (Number.isNaN(parsed)) return err('Invalid due_date. Use an ISO date like 2026-04-30.');
      }

      const id = milestoneId();
      const now = nowTimestamp();
      await repo.upsertMilestone({
        id,
        project_id,
        title,
        description: description ?? '',
        branch: branch ?? null,
        brief: null,
        status: 'active',
        due_date: due_date ?? null,
        completed_at: null,
        pinned_at: pinned ? now : null,
        created_at: now,
        updated_at: now,
      });

      return json({ id, title });
    }
  );

  server.tool(
    'update_milestone',
    'Update a milestone — title, description, branch, status, brief, due date, or pin state.',
    {
      milestone_id: z.string().describe('The milestone ID to update'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      branch: z.string().optional().describe('New branch'),
      status: z.enum(['active', 'completed', 'archived']).optional().describe('New status'),
      brief: z.string().optional().describe('Full markdown content of the milestone brief'),
      due_date: z.string().optional().describe('Due date in ISO format. Pass empty string to clear.'),
      pinned: z.boolean().optional().describe('true pins the milestone to Home, false unpins it.'),
    },
    async ({ milestone_id, title, description, branch, status, brief, due_date, pinned }) => {
      const existing = await repo.getMilestone(milestone_id);
      if (!existing) return err(`Milestone not found: ${milestone_id}`);

      const next = { ...existing };
      if (title !== undefined) next.title = title;
      if (description !== undefined) next.description = description;
      if (branch !== undefined) next.branch = branch || null;
      if (brief !== undefined) next.brief = brief;

      if (status !== undefined) {
        next.status = status;
        if (status === 'completed' && existing.status !== 'completed') {
          next.completed_at = nowTimestamp();
        }
        if (status !== 'completed') {
          next.completed_at = null;
        }
      }

      if (due_date !== undefined) {
        if (due_date === '') {
          next.due_date = null;
        } else {
          const parsed = Date.parse(due_date);
          if (Number.isNaN(parsed)) return err('Invalid due_date. Use an ISO date like 2026-04-30.');
          next.due_date = due_date;
        }
      }

      if (pinned !== undefined) {
        next.pinned_at = pinned ? nowTimestamp() : null;
      }

      next.updated_at = nowTimestamp();
      await repo.upsertMilestone(next);

      return json({ ok: true });
    }
  );

  server.tool(
    'read_milestone_brief',
    'Read a milestone brief — the deliverable-focused document describing goals and scope.',
    { milestone_id: z.string().describe('The milestone ID to read the brief for') },
    async ({ milestone_id }) => {
      const existing = await repo.getMilestone(milestone_id);
      if (!existing) return err(`Milestone not found: ${milestone_id}`);

      return json({ brief: existing.brief ?? '' });
    }
  );
}
