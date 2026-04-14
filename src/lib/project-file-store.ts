/**
 * File-backed project store.
 *
 * Owns the on-disk layout of a single project folder and maintains an
 * in-memory index that is kept in sync with the filesystem via chokidar.
 *
 * Layout (all paths relative to the project folder):
 *
 *   .omni/project.yml             — project config (id, label, slug, pipeline, source)
 *   context.md                    — freeform project brief, opaque markdown
 *   tickets/<id>.md               — ticket frontmatter + description body
 *   tickets/<id>.comments.jsonl   — append-only comments (sidecar)
 *   tickets/<id>.runs.jsonl       — append-only run history (sidecar)
 *   milestones/<id>.md            — milestone frontmatter + brief body
 *   pages/<id>.md                 — non-root pages with properties in frontmatter
 *
 * The root page (is_root=true) is not persisted as a .md file — it is
 * synthesized at the call site from project config + context.md.
 *
 * Writes go through {@link notePendingWrite} first so the watcher can drop
 * echo events. JSONL sidecars are rewritten in full rather than appended so
 * echo suppression can compare the whole-file content.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import { mkdir, readdir, readFile, stat,unlink, writeFile } from 'fs/promises';
import path from 'path';

import {
  parseMilestoneFile,
  parsePageFile,
  parseProjectConfig,
  parseTicketComments,
  parseTicketFile,
  parseTicketRuns,
  ProjectFileError,
  serializeMilestoneFile,
  serializePageFile,
  serializeProjectConfig,
  serializeTicketComment,
  serializeTicketFile,
  serializeTicketRun,
} from '@/lib/project-files';
import { Err, Ok } from '@/lib/result';
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProjectFileStoreEvents {
  onProjectChanged(project: Project): void;
  onTicketChanged(ticket: Ticket): void;
  onTicketRemoved(id: TicketId): void;
  onMilestoneChanged(milestone: Milestone): void;
  onMilestoneRemoved(id: MilestoneId): void;
  onPageChanged(page: Page, body: string): void;
  onPageRemoved(id: PageId): void;
  onContextChanged(content: string): void;
  onParseError(filePath: string, error: ProjectFileError): void;
}

export interface ProjectFileStoreOptions {
  /** Chokidar factory override for tests. */
  createWatcher?: (paths: string[]) => FSWatcher;
  /** Emit structured debug logs. */
  debug?: boolean;
}

export interface ProjectFileStoreStats {
  tickets: number;
  milestones: number;
  pages: number;
  parseErrors: number;
  writes: number;
  echoesSuppressed: number;
  externalChanges: number;
  externalDeletes: number;
}

// ---------------------------------------------------------------------------
// Path layout
// ---------------------------------------------------------------------------

const OMNI_DIR = '.omni';
const PROJECT_FILE = 'project.yml';
const CONTEXT_FILE = 'context.md';
const TICKETS_DIR = 'tickets';
const MILESTONES_DIR = 'milestones';
const PAGES_DIR = 'pages';

const TICKET_MD_SUFFIX = '.md';
const TICKET_COMMENTS_SUFFIX = '.comments.jsonl';
const TICKET_RUNS_SUFFIX = '.runs.jsonl';

interface Layout {
  root: string;
  omniDir: string;
  projectFile: string;
  contextFile: string;
  ticketsDir: string;
  milestonesDir: string;
  pagesDir: string;
}

const layoutFor = (root: string): Layout => ({
  root,
  omniDir: path.join(root, OMNI_DIR),
  projectFile: path.join(root, OMNI_DIR, PROJECT_FILE),
  contextFile: path.join(root, CONTEXT_FILE),
  ticketsDir: path.join(root, TICKETS_DIR),
  milestonesDir: path.join(root, MILESTONES_DIR),
  pagesDir: path.join(root, PAGES_DIR),
});

// ---------------------------------------------------------------------------
// File kind classification — every path the watcher sees is classified into
// one of these so the change handler can dispatch without re-parsing the path.
// ---------------------------------------------------------------------------

type FileKind =
  | { kind: 'project-config' }
  | { kind: 'context' }
  | { kind: 'ticket'; id: TicketId }
  | { kind: 'ticket-comments'; id: TicketId }
  | { kind: 'ticket-runs'; id: TicketId }
  | { kind: 'milestone'; id: MilestoneId }
  | { kind: 'page'; id: PageId }
  | { kind: 'unknown' };

const classifyFile = (filePath: string, layout: Layout): FileKind => {
  if (filePath === layout.projectFile) {
return { kind: 'project-config' };
}
  if (filePath === layout.contextFile) {
return { kind: 'context' };
}
  const inDir = (dir: string) => filePath.startsWith(dir + path.sep);
  if (inDir(layout.ticketsDir)) {
    const name = path.basename(filePath);
    if (name.endsWith(TICKET_COMMENTS_SUFFIX)) {
      return { kind: 'ticket-comments', id: name.slice(0, -TICKET_COMMENTS_SUFFIX.length) as TicketId };
    }
    if (name.endsWith(TICKET_RUNS_SUFFIX)) {
      return { kind: 'ticket-runs', id: name.slice(0, -TICKET_RUNS_SUFFIX.length) as TicketId };
    }
    if (name.endsWith(TICKET_MD_SUFFIX)) {
      return { kind: 'ticket', id: name.slice(0, -TICKET_MD_SUFFIX.length) as TicketId };
    }
  }
  if (inDir(layout.milestonesDir)) {
    const name = path.basename(filePath);
    if (name.endsWith(TICKET_MD_SUFFIX)) {
      return { kind: 'milestone', id: name.slice(0, -TICKET_MD_SUFFIX.length) as MilestoneId };
    }
  }
  if (inDir(layout.pagesDir)) {
    const name = path.basename(filePath);
    if (name.endsWith(TICKET_MD_SUFFIX)) {
      return { kind: 'page', id: name.slice(0, -TICKET_MD_SUFFIX.length) as PageId };
    }
  }
  return { kind: 'unknown' };
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ProjectFileStore {
  readonly projectId: ProjectId;
  readonly root: string;
  private readonly layout: Layout;
  private readonly events: ProjectFileStoreEvents;
  private readonly createWatcher: (paths: string[]) => FSWatcher;
  private readonly debug: boolean;

  private watcher: FSWatcher | null = null;
  private opened = false;
  private closed = false;

  private project: Project | null = null;
  private contextMd = '';
  private readonly tickets = new Map<TicketId, Ticket>();
  private readonly ticketBodies = new Map<TicketId, string>();
  private readonly comments = new Map<TicketId, TicketComment[]>();
  private readonly runs = new Map<TicketId, TicketRun[]>();
  private readonly milestones = new Map<MilestoneId, Milestone>();
  private readonly pages = new Map<PageId, Page>();
  private readonly pageBodies = new Map<PageId, string>();

  /** echo suppression: content we expect to see reflected back on next change event. */
  private readonly pendingWrites = new Map<string, string>();

  private readonly stats: ProjectFileStoreStats = {
    tickets: 0,
    milestones: 0,
    pages: 0,
    parseErrors: 0,
    writes: 0,
    echoesSuppressed: 0,
    externalChanges: 0,
    externalDeletes: 0,
  };

  constructor(
    projectDir: string,
    projectId: ProjectId,
    events: ProjectFileStoreEvents,
    options: ProjectFileStoreOptions = {}
  ) {
    this.root = projectDir;
    this.projectId = projectId;
    this.layout = layoutFor(projectDir);
    this.events = events;
    this.debug = options.debug ?? false;
    this.createWatcher =
      options.createWatcher ??
      ((paths) =>
        chokidar.watch(paths, {
          ignoreInitial: true,
          awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 30 },
          persistent: true,
        }));
  }

  // ---------- lifecycle ----------

  /**
   * Scan the project folder, populate the in-memory index, and start
   * watching for external changes. Safe to call multiple times — subsequent
   * calls are no-ops.
   */
  async open(): Promise<void> {
    if (this.opened || this.closed) {
return;
}
    this.opened = true;

    await this.ensureDirectories();
    await this.scanAll();
    await this.startWatcher();
    this.log('opened', {
      tickets: this.tickets.size,
      milestones: this.milestones.size,
      pages: this.pages.size,
    });
  }

  /** Stop watching and release resources. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this.closed) {
return;
}
    this.closed = true;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  getStats(): Readonly<ProjectFileStoreStats> {
    return {
      ...this.stats,
      tickets: this.tickets.size,
      milestones: this.milestones.size,
      pages: this.pages.size,
    };
  }

  // ---------- read accessors ----------

  getProject(): Project | null {
    return this.project;
  }

  getContextMd(): string {
    return this.contextMd;
  }

  listTickets(): Ticket[] {
    return [...this.tickets.values()].map((t) => this.assembleTicket(t));
  }

  getTicket(id: TicketId): Ticket | null {
    const base = this.tickets.get(id);
    return base ? this.assembleTicket(base) : null;
  }

  listMilestones(): Milestone[] {
    return [...this.milestones.values()];
  }

  getMilestone(id: MilestoneId): Milestone | null {
    return this.milestones.get(id) ?? null;
  }

  listPages(): Page[] {
    return [...this.pages.values()];
  }

  getPage(id: PageId): Page | null {
    return this.pages.get(id) ?? null;
  }

  getPageBody(id: PageId): string | null {
    return this.pageBodies.get(id) ?? null;
  }

  getTicketComments(id: TicketId): TicketComment[] {
    return [...(this.comments.get(id) ?? [])];
  }

  getTicketRuns(id: TicketId): TicketRun[] {
    return [...(this.runs.get(id) ?? [])];
  }

  // ---------- write operations ----------

  async writeProjectConfig(project: Project): Promise<void> {
    const text = serializeProjectConfig({ ...project, id: this.projectId });
    await this.writeFileEchoSuppressed(this.layout.projectFile, text);
    this.project = { ...project, id: this.projectId };
  }

  async writeContextMd(content: string): Promise<void> {
    await this.writeFileEchoSuppressed(this.layout.contextFile, content);
    this.contextMd = content;
  }

  async writeTicket(ticket: Ticket): Promise<void> {
    const scoped: Ticket = { ...ticket, projectId: this.projectId };
    const text = serializeTicketFile(scoped);
    await this.writeFileEchoSuppressed(this.ticketPath(scoped.id), text);
    this.tickets.set(scoped.id, this.stripAssembled(scoped));
    this.ticketBodies.set(scoped.id, scoped.description ?? '');
  }

  async writeMilestone(milestone: Milestone): Promise<void> {
    const scoped: Milestone = { ...milestone, projectId: this.projectId };
    const text = serializeMilestoneFile(scoped);
    await this.writeFileEchoSuppressed(this.milestonePath(scoped.id), text);
    this.milestones.set(scoped.id, scoped);
  }

  async writePage(page: Page, body: string): Promise<void> {
    const scoped: Page = { ...page, projectId: this.projectId };
    const text = serializePageFile(scoped, body);
    await this.writeFileEchoSuppressed(this.pagePath(scoped.id), text);
    this.pages.set(scoped.id, scoped);
    this.pageBodies.set(scoped.id, body);
  }

  async appendTicketComment(ticketId: TicketId, comment: TicketComment): Promise<void> {
    if (!this.tickets.has(ticketId)) {
throw new Error(`unknown ticket: ${ticketId}`);
}
    const current = this.comments.get(ticketId) ?? [];
    const next = [...current, comment];
    const text = next.map(serializeTicketComment).join('');
    await this.writeFileEchoSuppressed(this.commentsPath(ticketId), text);
    this.comments.set(ticketId, next);
  }

  async appendTicketRun(ticketId: TicketId, run: TicketRun): Promise<void> {
    if (!this.tickets.has(ticketId)) {
throw new Error(`unknown ticket: ${ticketId}`);
}
    const current = this.runs.get(ticketId) ?? [];
    const next = [...current, run];
    const text = next.map(serializeTicketRun).join('');
    await this.writeFileEchoSuppressed(this.runsPath(ticketId), text);
    this.runs.set(ticketId, next);
  }

  async deleteTicket(id: TicketId): Promise<void> {
    await this.deleteFileQuiet(this.ticketPath(id));
    await this.deleteFileQuiet(this.commentsPath(id));
    await this.deleteFileQuiet(this.runsPath(id));
    this.tickets.delete(id);
    this.ticketBodies.delete(id);
    this.comments.delete(id);
    this.runs.delete(id);
  }

  async deleteMilestone(id: MilestoneId): Promise<void> {
    await this.deleteFileQuiet(this.milestonePath(id));
    this.milestones.delete(id);
  }

  async deletePage(id: PageId): Promise<void> {
    await this.deleteFileQuiet(this.pagePath(id));
    this.pages.delete(id);
    this.pageBodies.delete(id);
  }

  // ---------- internals ----------

  private ticketPath(id: TicketId): string {
    return path.join(this.layout.ticketsDir, `${id}${TICKET_MD_SUFFIX}`);
  }
  private commentsPath(id: TicketId): string {
    return path.join(this.layout.ticketsDir, `${id}${TICKET_COMMENTS_SUFFIX}`);
  }
  private runsPath(id: TicketId): string {
    return path.join(this.layout.ticketsDir, `${id}${TICKET_RUNS_SUFFIX}`);
  }
  private milestonePath(id: MilestoneId): string {
    return path.join(this.layout.milestonesDir, `${id}${TICKET_MD_SUFFIX}`);
  }
  private pagePath(id: PageId): string {
    return path.join(this.layout.pagesDir, `${id}${TICKET_MD_SUFFIX}`);
  }

  /** Assemble a ticket from its stored base + current comments/runs. */
  private assembleTicket(base: Ticket): Ticket {
    return {
      ...base,
      description: this.ticketBodies.get(base.id) ?? base.description ?? '',
      comments: [...(this.comments.get(base.id) ?? [])],
      runs: [...(this.runs.get(base.id) ?? [])],
    };
  }

  /** Strip comments/runs so we don't store them redundantly inside the ticket record. */
  private stripAssembled(ticket: Ticket): Ticket {
    return { ...ticket, comments: [], runs: [] };
  }

  private async ensureDirectories(): Promise<void> {
    for (const dir of [this.layout.omniDir, this.layout.ticketsDir, this.layout.milestonesDir, this.layout.pagesDir]) {
      await mkdir(dir, { recursive: true });
    }
  }

  private async scanAll(): Promise<void> {
    await this.scanProjectConfig();
    await this.scanContext();
    await this.scanTickets();
    await this.scanMilestones();
    await this.scanPages();
  }

  private async scanProjectConfig(): Promise<void> {
    const text = await readIfExists(this.layout.projectFile);
    if (text === null) {
return;
}
    const parsed = parseProjectConfig(text);
    if (parsed.isErr()) {
      this.emitParseError(this.layout.projectFile, parsed.error);
      return;
    }
    this.project = { ...parsed.value, id: this.projectId };
  }

  private async scanContext(): Promise<void> {
    const text = await readIfExists(this.layout.contextFile);
    this.contextMd = text ?? '';
  }

  private async scanTickets(): Promise<void> {
    const entries = await listDir(this.layout.ticketsDir);
    for (const name of entries) {
      const full = path.join(this.layout.ticketsDir, name);
      if (name.endsWith(TICKET_COMMENTS_SUFFIX)) {
        const id = name.slice(0, -TICKET_COMMENTS_SUFFIX.length) as TicketId;
        await this.loadTicketComments(id, full);
      } else if (name.endsWith(TICKET_RUNS_SUFFIX)) {
        const id = name.slice(0, -TICKET_RUNS_SUFFIX.length) as TicketId;
        await this.loadTicketRuns(id, full);
      } else if (name.endsWith(TICKET_MD_SUFFIX)) {
        const id = name.slice(0, -TICKET_MD_SUFFIX.length) as TicketId;
        await this.loadTicket(id, full);
      }
    }
  }

  private async loadTicket(id: TicketId, filePath: string): Promise<void> {
    const text = await readIfExists(filePath);
    if (text === null) {
return;
}
    const parsed = parseTicketFile(text, id, this.projectId);
    if (parsed.isErr()) {
      this.emitParseError(filePath, parsed.error);
      return;
    }
    this.tickets.set(id, this.stripAssembled(parsed.value));
    this.ticketBodies.set(id, parsed.value.description ?? '');
  }

  private async loadTicketComments(id: TicketId, filePath: string): Promise<void> {
    const text = await readIfExists(filePath);
    if (text === null) {
return;
}
    const { items, errors } = parseTicketComments(text);
    this.comments.set(id, items);
    for (const e of errors) {
      this.emitParseError(filePath, new ProjectFileError(`line ${e.line}: ${e.message}`));
    }
  }

  private async loadTicketRuns(id: TicketId, filePath: string): Promise<void> {
    const text = await readIfExists(filePath);
    if (text === null) {
return;
}
    const { items, errors } = parseTicketRuns(text);
    this.runs.set(id, items);
    for (const e of errors) {
      this.emitParseError(filePath, new ProjectFileError(`line ${e.line}: ${e.message}`));
    }
  }

  private async scanMilestones(): Promise<void> {
    const entries = await listDir(this.layout.milestonesDir);
    for (const name of entries) {
      if (!name.endsWith(TICKET_MD_SUFFIX)) {
continue;
}
      const id = name.slice(0, -TICKET_MD_SUFFIX.length) as MilestoneId;
      const full = path.join(this.layout.milestonesDir, name);
      const text = await readIfExists(full);
      if (text === null) {
continue;
}
      const parsed = parseMilestoneFile(text, id, this.projectId);
      if (parsed.isErr()) {
        this.emitParseError(full, parsed.error);
        continue;
      }
      this.milestones.set(id, parsed.value);
    }
  }

  private async scanPages(): Promise<void> {
    const entries = await listDir(this.layout.pagesDir);
    for (const name of entries) {
      if (!name.endsWith(TICKET_MD_SUFFIX)) {
continue;
}
      const id = name.slice(0, -TICKET_MD_SUFFIX.length) as PageId;
      const full = path.join(this.layout.pagesDir, name);
      const text = await readIfExists(full);
      if (text === null) {
continue;
}
      const parsed = parsePageFile(text, id, this.projectId);
      if (parsed.isErr()) {
        this.emitParseError(full, parsed.error);
        continue;
      }
      this.pages.set(id, parsed.value.page);
      this.pageBodies.set(id, parsed.value.body);
    }
  }

  // ---------- watcher ----------

  private async startWatcher(): Promise<void> {
    const watcher = this.createWatcher([
      this.layout.projectFile,
      this.layout.contextFile,
      this.layout.ticketsDir,
      this.layout.milestonesDir,
      this.layout.pagesDir,
    ]);
    watcher.on('add', (p: string) => {
      void this.handleAddOrChange(p);
    });
    watcher.on('change', (p: string) => {
      void this.handleAddOrChange(p);
    });
    watcher.on('unlink', (p: string) => {
      this.handleUnlink(p);
    });
    watcher.on('error', (err: unknown) => {
      console.warn('[ProjectFileStore] chokidar error:', err);
    });
    this.watcher = watcher;
    // Wait until chokidar finishes its initial scan so new-file events fire
    // reliably. Without this, adds that race the watcher's setup are missed.
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) {
return;
}
        settled = true;
        resolve();
      };
      watcher.on('ready', done);
      // Fall-through safety: if the watcher implementation never emits ready
      // (e.g. a test mock), proceed after a short timeout rather than hanging.
      setTimeout(done, 500);
    });
  }

  private async handleAddOrChange(filePath: string): Promise<void> {
    if (this.closed) {
return;
}
    const text = await readIfExists(filePath);
    if (text === null) {
return;
}
    if (this.pendingWrites.get(filePath) === text) {
      this.pendingWrites.delete(filePath);
      this.stats.echoesSuppressed++;
      this.log('echo-suppressed', { filePath });
      return;
    }
    this.pendingWrites.delete(filePath);
    this.stats.externalChanges++;
    const kind = classifyFile(filePath, this.layout);
    switch (kind.kind) {
      case 'project-config': {
        const parsed = parseProjectConfig(text);
        if (parsed.isErr()) {
return this.emitParseError(filePath, parsed.error);
}
        this.project = { ...parsed.value, id: this.projectId };
        this.events.onProjectChanged(this.project);
        return;
      }
      case 'context': {
        this.contextMd = text;
        this.events.onContextChanged(text);
        return;
      }
      case 'ticket': {
        const parsed = parseTicketFile(text, kind.id, this.projectId);
        if (parsed.isErr()) {
return this.emitParseError(filePath, parsed.error);
}
        this.tickets.set(kind.id, this.stripAssembled(parsed.value));
        this.ticketBodies.set(kind.id, parsed.value.description ?? '');
        this.events.onTicketChanged(this.assembleTicket(parsed.value));
        return;
      }
      case 'ticket-comments': {
        const { items, errors } = parseTicketComments(text);
        this.comments.set(kind.id, items);
        for (const e of errors) {
          this.emitParseError(filePath, new ProjectFileError(`line ${e.line}: ${e.message}`));
        }
        const base = this.tickets.get(kind.id);
        if (base) {
this.events.onTicketChanged(this.assembleTicket(base));
}
        return;
      }
      case 'ticket-runs': {
        const { items, errors } = parseTicketRuns(text);
        this.runs.set(kind.id, items);
        for (const e of errors) {
          this.emitParseError(filePath, new ProjectFileError(`line ${e.line}: ${e.message}`));
        }
        const base = this.tickets.get(kind.id);
        if (base) {
this.events.onTicketChanged(this.assembleTicket(base));
}
        return;
      }
      case 'milestone': {
        const parsed = parseMilestoneFile(text, kind.id, this.projectId);
        if (parsed.isErr()) {
return this.emitParseError(filePath, parsed.error);
}
        this.milestones.set(kind.id, parsed.value);
        this.events.onMilestoneChanged(parsed.value);
        return;
      }
      case 'page': {
        const parsed = parsePageFile(text, kind.id, this.projectId);
        if (parsed.isErr()) {
return this.emitParseError(filePath, parsed.error);
}
        this.pages.set(kind.id, parsed.value.page);
        this.pageBodies.set(kind.id, parsed.value.body);
        this.events.onPageChanged(parsed.value.page, parsed.value.body);
        return;
      }
      case 'unknown':
        return;
    }
  }

  private handleUnlink(filePath: string): void {
    if (this.closed) {
return;
}
    this.pendingWrites.delete(filePath);
    this.stats.externalDeletes++;
    const kind = classifyFile(filePath, this.layout);
    switch (kind.kind) {
      case 'ticket':
        this.tickets.delete(kind.id);
        this.ticketBodies.delete(kind.id);
        this.events.onTicketRemoved(kind.id);
        return;
      case 'ticket-comments': {
        this.comments.delete(kind.id);
        const base = this.tickets.get(kind.id);
        if (base) {
this.events.onTicketChanged(this.assembleTicket(base));
}
        return;
      }
      case 'ticket-runs': {
        this.runs.delete(kind.id);
        const base = this.tickets.get(kind.id);
        if (base) {
this.events.onTicketChanged(this.assembleTicket(base));
}
        return;
      }
      case 'milestone':
        this.milestones.delete(kind.id);
        this.events.onMilestoneRemoved(kind.id);
        return;
      case 'page':
        this.pages.delete(kind.id);
        this.pageBodies.delete(kind.id);
        this.events.onPageRemoved(kind.id);
        return;
      case 'context':
        this.contextMd = '';
        this.events.onContextChanged('');
        return;
      default:
        return;
    }
  }

  // ---------- fs helpers ----------

  private async writeFileEchoSuppressed(filePath: string, content: string): Promise<void> {
    this.pendingWrites.set(filePath, content);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    this.stats.writes++;
  }

  private async deleteFileQuiet(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
return;
}
      throw err;
    }
  }

  private emitParseError(filePath: string, error: ProjectFileError): void {
    this.stats.parseErrors++;
    this.log('parse-error', { filePath, message: error.message, path: error.path });
    this.events.onParseError(filePath, error);
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    if (!this.debug) {
return;
}
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    console.log(`[ProjectFileStore:${this.projectId}] ${event}${parts.length ? ` ${  parts.join(' ')}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
return null;
}
    throw err;
  }
}

async function listDir(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
return [];
}
    throw err;
  }
}

/** Re-exported for test convenience: check if a project folder has been initialized. */
export async function isProjectFolder(dir: string): Promise<boolean> {
  try {
    const st = await stat(path.join(dir, OMNI_DIR, PROJECT_FILE));
    return st.isFile();
  } catch {
    return false;
  }
}

// Re-exports — kept here so callers import from a single module, not two.
export { Err, Ok };
