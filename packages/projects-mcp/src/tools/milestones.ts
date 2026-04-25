import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectsRepo } from 'omni-projects-db';
import { milestoneId } from 'omni-projects-db';
import type { MilestoneRow } from 'omni-projects-db';
import { z } from 'zod';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const });

export function registerMilestoneTools(server: McpServer, db: DatabaseSync, repo: ProjectsRepo): void {
  server.tool(
    'list_milestones',
    'List all milestones for a project.',
    { project_id: z.string().describe('The project ID to list milestones for') },
    async ({ project_id }) => {
      const exists = repo.getProject(project_id);
      if (!exists) return err(`Project not found: ${project_id}`);

      const milestones = repo.listMilestonesByProject(project_id);

      return json({
        milestones: milestones.map(m => ({
          id: m.id,
          title: m.title,
          description: m.description,
          branch: m.branch,
          status: m.status,
          due_date: m.due_date,
          completed_at: m.completed_at,
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
    },
    async ({ project_id, title, description, branch, due_date }) => {
      const exists = repo.getProject(project_id);
      if (!exists) return err(`Project not found: ${project_id}`);

      if (due_date) {
        const parsed = Date.parse(due_date);
        if (Number.isNaN(parsed)) return err('Invalid due_date. Use an ISO date like 2026-04-30.');
      }

      const id = milestoneId();
      db.prepare(`
        INSERT INTO milestones (id, project_id, title, description, branch, due_date)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, project_id, title, description ?? '', branch ?? null, due_date ?? null);
      repo.bumpChangeSeq();

      return json({ id, title });
    }
  );

  server.tool(
    'update_milestone',
    'Update a milestone — title, description, branch, status, brief, or due date.',
    {
      milestone_id: z.string().describe('The milestone ID to update'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      branch: z.string().optional().describe('New branch'),
      status: z.enum(['active', 'completed', 'archived']).optional().describe('New status'),
      brief: z.string().optional().describe('Full markdown content of the milestone brief'),
      due_date: z.string().optional().describe('Due date in ISO format. Pass empty string to clear.'),
    },
    async ({ milestone_id, title, description, branch, status, brief, due_date }) => {
      const existing = repo.getMilestone(milestone_id);
      if (!existing) return err(`Milestone not found: ${milestone_id}`);

      const sets: string[] = [];
      const params: unknown[] = [];

      if (title !== undefined) { sets.push('title = ?'); params.push(title); }
      if (description !== undefined) { sets.push('description = ?'); params.push(description); }
      if (branch !== undefined) { sets.push('branch = ?'); params.push(branch || null); }
      if (brief !== undefined) { sets.push('brief = ?'); params.push(brief); }

      if (status !== undefined) {
        sets.push('status = ?');
        params.push(status);
        if (status === 'completed' && existing.status !== 'completed') {
          sets.push("completed_at = datetime('now')");
        }
        if (status !== 'completed') {
          sets.push('completed_at = NULL');
        }
      }

      if (due_date !== undefined) {
        if (due_date === '') {
          sets.push('due_date = NULL');
        } else {
          const parsed = Date.parse(due_date);
          if (Number.isNaN(parsed)) return err('Invalid due_date. Use an ISO date like 2026-04-30.');
          sets.push('due_date = ?');
          params.push(due_date);
        }
      }

      if (sets.length === 0) return json({ ok: true });

      sets.push("updated_at = datetime('now')");
      params.push(milestone_id);
      db.prepare(`UPDATE milestones SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      repo.bumpChangeSeq();

      return json({ ok: true });
    }
  );

  server.tool(
    'read_milestone_brief',
    'Read a milestone brief — the deliverable-focused document describing goals and scope.',
    { milestone_id: z.string().describe('The milestone ID to read the brief for') },
    async ({ milestone_id }) => {
      const existing = repo.getMilestone(milestone_id);
      if (!existing) return err(`Milestone not found: ${milestone_id}`);

      return json({ brief: existing.brief ?? '' });
    }
  );
}
