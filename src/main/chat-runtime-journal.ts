import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

import { AgentHostControlClient } from './agent-host-control-client';
import { decodeAgentHostResources } from './agent-process';
import type { IComputeClient } from './platform-client';

export const runtimeOwner = `${hostname()}:${process.pid}`;
const processBirth = (pid: number): string | undefined => {
  if (process.platform !== 'linux') {
    return undefined;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? undefined : fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};
export function assertCleanupOwner(owner?: string): void {
  if (!owner || owner === runtimeOwner) {
    return;
  }
  const prefix = `${hostname()}:`;
  if (!owner.startsWith(prefix)) {
    throw new Error('Cleanup is waiting for the runtime owner machine');
  }
  const pid = Number(owner.slice(prefix.length));
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Invalid runtime owner');
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return;
    }
    throw error;
  }
  throw new Error('Cleanup is waiting for the runtime owner process');
}

/** Private control credentials must never enter StoreData or a renderer snapshot. */
export type ChatRuntimeClaim = {
  consumerId: string;
  workspaceId: string;
  snapshotRef: string;
  hostId: string;
  wsUrl: string;
  controlToken: string;
  pid: number;
  machine: string;
  owner?: string;
  pidBirth?: string;
};

export class ChatRuntimeJournal {
  constructor(
    private readonly dir: string,
    private readonly computeClient?: (profile: string) => IComputeClient | null
  ) {}

  recordCompute(id: string, profile: string, sessionId: string): void {
    const file = `${this.filename(id)}.compute`;
    const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    const records = [
      ...previous.filter((entry: { sessionId: string }) => entry.sessionId !== sessionId),
      { consumerId: id, owner: runtimeOwner, profile, sessionId },
    ];
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(records));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  }

  private filename(id: string): string {
    return path.join(this.dir, `${createHash('sha256').update(id).digest('hex')}.json`);
  }

  private read(id: string): ChatRuntimeClaim[] {
    try {
      const value: unknown = JSON.parse(readFileSync(this.filename(id), 'utf8'));
      if (
        !Array.isArray(value) ||
        value.some(
          (v) =>
            !v ||
            v.consumerId !== id ||
            typeof v.workspaceId !== 'string' ||
            typeof v.hostId !== 'string' ||
            typeof v.wsUrl !== 'string' ||
            typeof v.controlToken !== 'string' ||
            typeof v.machine !== 'string' ||
            !Number.isSafeInteger(v.pid) ||
            v.pid <= 0
        )
      ) {
        throw new Error('Invalid runtime ownership journal');
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /** Runs before the first materialization RPC, including retries/rebindings. */
  record = (claim: Omit<ChatRuntimeClaim, 'machine'>): void => {
    const claims = this.read(claim.consumerId).filter(
      (v) => v.hostId !== claim.hostId || v.workspaceId !== claim.workspaceId
    );
    claims.push({ ...claim, machine: hostname(), owner: runtimeOwner, pidBirth: processBirth(claim.pid) });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.filename(claim.consumerId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(claims));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  };

  async retire(id: string): Promise<void> {
    const computeFile = `${this.filename(id)}.compute`;
    if (existsSync(computeFile)) {
      const records = JSON.parse(readFileSync(computeFile, 'utf8'));
      if (!Array.isArray(records)) {
        throw new Error('Invalid compute ownership journal');
      }
      for (const record of records) {
        if (record.consumerId !== id || typeof record.sessionId !== 'string' || typeof record.profile !== 'string') {
          throw new Error('Invalid compute ownership journal');
        }
        assertCleanupOwner(record.owner);
        const client = this.computeClient?.(record.profile);
        if (!client) {
          throw new Error('Compute cleanup is waiting for its provider');
        }
        await client.stopSession(record.sessionId);
      }
      unlinkSync(computeFile);
    }
    for (const claim of this.read(id)) {
      assertCleanupOwner(claim.owner);
      if (claim.machine !== hostname()) {
        throw new Error('Runtime cleanup must run on its owning machine');
      }
      // ESRCH is evidence of exit; permission errors and PID reuse are not.
      let alive = true;
      try {
        process.kill(claim.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }
        alive = false;
      }
      if (!alive) {
        continue;
      }
      if (claim.pidBirth && processBirth(claim.pid) !== claim.pidBirth) {
        continue;
      }
      // A crashed launcher's stdout/control pipes may no longer service RPC.
      // On Linux, the durable PID + kernel birth stamp proves this is exactly
      // its orphan child, so termination does not depend on a healthy socket.
      if (claim.owner && claim.owner !== runtimeOwner && claim.pidBirth) {
        process.kill(claim.pid, 'SIGTERM');
        const wait = async () => {
          const until = Date.now() + 2_000;
          while (processBirth(claim.pid) === claim.pidBirth && Date.now() < until) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 50);
            });
          }
        };
        await wait();
        if (processBirth(claim.pid) === claim.pidBirth) {
          process.kill(claim.pid, 'SIGKILL');
          await wait();
        }
        if (processBirth(claim.pid) === claim.pidBirth) {
          throw new Error('Orphan host exit is not yet confirmed');
        }
        continue;
      }
      const control = new AgentHostControlClient(claim.wsUrl, claim.controlToken, 10_000);
      try {
        const list = async () => {
          const resources = decodeAgentHostResources(await control.call('agent_host_list_resources', {}));
          if (resources.agentHostId !== claim.hostId) {
            throw new Error('Runtime identity changed during cleanup');
          }
          const workspace = resources.workspaces.find((w) => w.workspaceId === claim.workspaceId);
          if (workspace && workspace.snapshotRef !== claim.snapshotRef) {
            throw new Error('Workspace ownership changed during cleanup');
          }
          return resources.environments.filter((e) => e.workspaceId === claim.workspaceId);
        };
        for (const env of await list()) {
          if (env.state === 'stopped' || env.state === 'failed') {
            continue;
          }
          await control.call('agent_host_stop_environment', { environment_id: env.environmentId });
        }
        if ((await list()).some((e) => e.state !== 'stopped' && e.state !== 'failed')) {
          throw new Error('Runtime shutdown is not yet confirmed');
        }
      } finally {
        control.close();
      }
    }
    const file = this.filename(id);
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }

  async recoverAbandoned(): Promise<void> {
    if (!existsSync(this.dir)) {
      return;
    }
    for (const file of readdirSync(this.dir).filter((name) => name.endsWith('.json') || name.endsWith('.compute'))) {
      try {
        const raw = JSON.parse(readFileSync(path.join(this.dir, file), 'utf8')) as ChatRuntimeClaim[];
        const id = raw[0]?.consumerId;
        if (!id || ![this.filename(id), `${this.filename(id)}.compute`].includes(path.join(this.dir, file))) {
          throw new Error('Invalid recovery journal name');
        }
        if (raw.some((claim) => claim.owner === runtimeOwner)) {
          continue;
        }
        await this.retire(id);
      } catch (error) {
        // Ownership may belong to another live replica, or shutdown may be
        // temporarily unavailable. Keep the durable claim for the next sweep.
        const message = error instanceof Error ? error.message : '';
        const reason =
          message.startsWith('Cleanup is waiting') || message.startsWith('Runtime ') || message.startsWith('Workspace ')
            ? message
            : 'control operation failed';
        console.warn(`[chat-cleanup] recovery deferred: ${reason}`);
      }
    }
  }
}
