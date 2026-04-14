/**
 * Multi-project facade over {@link ProjectFileStore}.
 *
 * Owns one ProjectFileStore per open project, maintains reverse indexes from
 * ticket/milestone/page IDs to their owning project, and aggregates events
 * into a single typed stream that ProjectManager can subscribe to.
 *
 * Lifecycle:
 *   const mgr = new ProjectFileStoreManager(events);
 *   await mgr.open([{ id, dir }, ...]);   // one entry per known project
 *   // ... reads and writes ...
 *   await mgr.close();
 */

import { mkdir, rm } from 'fs/promises';
import path from 'path';

import { ProjectFileStore, type ProjectFileStoreEvents } from '@/lib/project-file-store';
import type { ProjectFileError } from '@/lib/project-files';
import type {
  Milestone,
  MilestoneId,
  Page,
  PageId,
  Project,
  ProjectId,
  Ticket,
  TicketComment,
  TicketId,
  TicketRun,
} from '@/shared/types';

export interface ManagedProjectRef {
  id: ProjectId;
  dir: string;
}

export interface ProjectFileStoreManagerEvents {
  onProjectChanged(project: Project): void;
  onTicketChanged(ticket: Ticket): void;
  onTicketRemoved(projectId: ProjectId, id: TicketId): void;
  onMilestoneChanged(milestone: Milestone): void;
  onMilestoneRemoved(projectId: ProjectId, id: MilestoneId): void;
  onPageChanged(page: Page, body: string): void;
  onPageRemoved(projectId: ProjectId, id: PageId): void;
  onContextChanged(projectId: ProjectId, content: string): void;
  onParseError(filePath: string, error: ProjectFileError): void;
}

export interface ProjectFileStoreManagerOptions {
  debug?: boolean;
}

export class ProjectFileStoreManager {
  private readonly stores = new Map<ProjectId, ProjectFileStore>();
  private readonly dirs = new Map<ProjectId, string>();
  private readonly ticketIndex = new Map<TicketId, ProjectId>();
  private readonly milestoneIndex = new Map<MilestoneId, ProjectId>();
  private readonly pageIndex = new Map<PageId, ProjectId>();

  constructor(
    private readonly events: ProjectFileStoreManagerEvents,
    private readonly options: ProjectFileStoreManagerOptions = {}
  ) {}

  // ---------- lifecycle ----------

  async open(refs: readonly ManagedProjectRef[]): Promise<void> {
    for (const ref of refs) {
      await this.openOne(ref);
    }
  }

  async close(): Promise<void> {
    for (const store of this.stores.values()) {
      await store.close();
    }
    this.stores.clear();
    this.dirs.clear();
    this.ticketIndex.clear();
    this.milestoneIndex.clear();
    this.pageIndex.clear();
  }

  /**
   * Create a brand-new project: make the directory, instantiate a store, and
   * persist `project.yml`. Call this after {@link open} so events route back
   * through the shared stream.
   */
  async createProject(project: Project, dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await this.openOne({ id: project.id, dir });
    await this.stores.get(project.id)!.writeProjectConfig(project);
  }

  /**
   * Close a project's store and drop its reverse-index entries. Does NOT
   * delete files by default — callers that want to wipe the folder pass
   * `deleteFiles: true`.
   */
  async removeProject(projectId: ProjectId, options: { deleteFiles?: boolean } = {}): Promise<void> {
    const store = this.stores.get(projectId);
    const dir = this.dirs.get(projectId);
    if (store) {
await store.close();
}
    this.stores.delete(projectId);
    this.dirs.delete(projectId);
    for (const [tid, pid] of [...this.ticketIndex]) {
if (pid === projectId) {
this.ticketIndex.delete(tid);
}
}
    for (const [mid, pid] of [...this.milestoneIndex]) {
if (pid === projectId) {
this.milestoneIndex.delete(mid);
}
}
    for (const [pgid, pid] of [...this.pageIndex]) {
if (pid === projectId) {
this.pageIndex.delete(pgid);
}
}
    if (options.deleteFiles && dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }

  hasProject(projectId: ProjectId): boolean {
    return this.stores.has(projectId);
  }

  getProjectDir(projectId: ProjectId): string | null {
    return this.dirs.get(projectId) ?? null;
  }

  // ---------- reads ----------

  listProjects(): Project[] {
    const out: Project[] = [];
    for (const store of this.stores.values()) {
      const p = store.getProject();
      if (p) {
out.push(p);
}
    }
    return out;
  }

  getProject(projectId: ProjectId): Project | null {
    return this.stores.get(projectId)?.getProject() ?? null;
  }

  getContextMd(projectId: ProjectId): string {
    return this.stores.get(projectId)?.getContextMd() ?? '';
  }

  listTickets(projectId?: ProjectId): Ticket[] {
    if (projectId) {
return this.stores.get(projectId)?.listTickets() ?? [];
}
    const out: Ticket[] = [];
    for (const store of this.stores.values()) {
out.push(...store.listTickets());
}
    return out;
  }

  getTicket(id: TicketId): Ticket | null {
    const pid = this.ticketIndex.get(id);
    if (!pid) {
return null;
}
    return this.stores.get(pid)?.getTicket(id) ?? null;
  }

  getTicketProjectId(id: TicketId): ProjectId | null {
    return this.ticketIndex.get(id) ?? null;
  }

  getTicketComments(id: TicketId): TicketComment[] {
    const pid = this.ticketIndex.get(id);
    if (!pid) {
return [];
}
    return this.stores.get(pid)?.getTicketComments(id) ?? [];
  }

  getTicketRuns(id: TicketId): TicketRun[] {
    const pid = this.ticketIndex.get(id);
    if (!pid) {
return [];
}
    return this.stores.get(pid)?.getTicketRuns(id) ?? [];
  }

  listMilestones(projectId?: ProjectId): Milestone[] {
    if (projectId) {
return this.stores.get(projectId)?.listMilestones() ?? [];
}
    const out: Milestone[] = [];
    for (const store of this.stores.values()) {
out.push(...store.listMilestones());
}
    return out;
  }

  getMilestone(id: MilestoneId): Milestone | null {
    const pid = this.milestoneIndex.get(id);
    if (!pid) {
return null;
}
    return this.stores.get(pid)?.getMilestone(id) ?? null;
  }

  listPages(projectId?: ProjectId): Page[] {
    if (projectId) {
return this.stores.get(projectId)?.listPages() ?? [];
}
    const out: Page[] = [];
    for (const store of this.stores.values()) {
out.push(...store.listPages());
}
    return out;
  }

  getPage(id: PageId): Page | null {
    const pid = this.pageIndex.get(id);
    if (!pid) {
return null;
}
    return this.stores.get(pid)?.getPage(id) ?? null;
  }

  getPageBody(id: PageId): string | null {
    const pid = this.pageIndex.get(id);
    if (!pid) {
return null;
}
    return this.stores.get(pid)?.getPageBody(id) ?? null;
  }

  getPageProjectId(id: PageId): ProjectId | null {
    return this.pageIndex.get(id) ?? null;
  }

  // ---------- writes ----------

  async writeProjectConfig(project: Project): Promise<void> {
    const store = this.requireStore(project.id);
    await store.writeProjectConfig(project);
  }

  async writeContextMd(projectId: ProjectId, content: string): Promise<void> {
    const store = this.requireStore(projectId);
    await store.writeContextMd(content);
  }

  async writeTicket(ticket: Ticket): Promise<void> {
    const store = this.requireStore(ticket.projectId);
    await store.writeTicket(ticket);
    this.ticketIndex.set(ticket.id, ticket.projectId);
  }

  async writeMilestone(milestone: Milestone): Promise<void> {
    const store = this.requireStore(milestone.projectId);
    await store.writeMilestone(milestone);
    this.milestoneIndex.set(milestone.id, milestone.projectId);
  }

  async writePage(page: Page, body: string): Promise<void> {
    const store = this.requireStore(page.projectId);
    await store.writePage(page, body);
    this.pageIndex.set(page.id, page.projectId);
  }

  async appendTicketComment(ticketId: TicketId, comment: TicketComment): Promise<void> {
    const pid = this.ticketIndex.get(ticketId);
    if (!pid) {
throw new Error(`unknown ticket: ${ticketId}`);
}
    await this.stores.get(pid)!.appendTicketComment(ticketId, comment);
  }

  async appendTicketRun(ticketId: TicketId, run: TicketRun): Promise<void> {
    const pid = this.ticketIndex.get(ticketId);
    if (!pid) {
throw new Error(`unknown ticket: ${ticketId}`);
}
    await this.stores.get(pid)!.appendTicketRun(ticketId, run);
  }

  async deleteTicket(id: TicketId): Promise<void> {
    const pid = this.ticketIndex.get(id);
    if (!pid) {
return;
}
    await this.stores.get(pid)!.deleteTicket(id);
    this.ticketIndex.delete(id);
  }

  async deleteMilestone(id: MilestoneId): Promise<void> {
    const pid = this.milestoneIndex.get(id);
    if (!pid) {
return;
}
    await this.stores.get(pid)!.deleteMilestone(id);
    this.milestoneIndex.delete(id);
  }

  async deletePage(id: PageId): Promise<void> {
    const pid = this.pageIndex.get(id);
    if (!pid) {
return;
}
    await this.stores.get(pid)!.deletePage(id);
    this.pageIndex.delete(id);
  }

  // ---------- internals ----------

  private async openOne(ref: ManagedProjectRef): Promise<ProjectFileStore> {
    const existing = this.stores.get(ref.id);
    if (existing) {
return existing;
}
    const store = new ProjectFileStore(ref.dir, ref.id, this.wrapEvents(ref.id), this.options);
    this.stores.set(ref.id, store);
    this.dirs.set(ref.id, path.resolve(ref.dir));
    await store.open();
    for (const t of store.listTickets()) {
this.ticketIndex.set(t.id, ref.id);
}
    for (const m of store.listMilestones()) {
this.milestoneIndex.set(m.id, ref.id);
}
    for (const p of store.listPages()) {
this.pageIndex.set(p.id, ref.id);
}
    return store;
  }

  private requireStore(projectId: ProjectId): ProjectFileStore {
    const s = this.stores.get(projectId);
    if (!s) {
throw new Error(`unknown project: ${projectId}`);
}
    return s;
  }

  private wrapEvents(projectId: ProjectId): ProjectFileStoreEvents {
    return {
      onProjectChanged: (project) => {
        this.events.onProjectChanged(project);
      },
      onTicketChanged: (ticket) => {
        this.ticketIndex.set(ticket.id, projectId);
        this.events.onTicketChanged(ticket);
      },
      onTicketRemoved: (id) => {
        this.ticketIndex.delete(id);
        this.events.onTicketRemoved(projectId, id);
      },
      onMilestoneChanged: (milestone) => {
        this.milestoneIndex.set(milestone.id, projectId);
        this.events.onMilestoneChanged(milestone);
      },
      onMilestoneRemoved: (id) => {
        this.milestoneIndex.delete(id);
        this.events.onMilestoneRemoved(projectId, id);
      },
      onPageChanged: (page, body) => {
        this.pageIndex.set(page.id, projectId);
        this.events.onPageChanged(page, body);
      },
      onPageRemoved: (id) => {
        this.pageIndex.delete(id);
        this.events.onPageRemoved(projectId, id);
      },
      onContextChanged: (content) => {
        this.events.onContextChanged(projectId, content);
      },
      onParseError: (filePath, error) => {
        this.events.onParseError(filePath, error);
      },
    };
  }
}
