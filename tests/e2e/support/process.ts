import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';

const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const tail = (value: string, lineCount = 120) => value.split('\n').slice(-lineCount).join('\n');

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32' || child.pid === undefined) {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ESRCH') {
      throw err;
    }
  }
}

export type ManagedProcess = {
  logs: () => string;
  stop: () => Promise<void>;
  waitForOutput: (pattern: RegExp, timeoutMs: number) => Promise<void>;
};

export function startProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): ManagedProcess {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let output = '';

  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf-8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf-8');
  });

  return {
    logs: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      signalProcessTree(child, 'SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
        }),
        delay(5_000).then(() => {
          if (child.exitCode === null && child.signalCode === null) {
            signalProcessTree(child, 'SIGKILL');
          }
        }),
      ]);
    },
    waitForOutput: async (pattern: RegExp, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pattern.test(output)) {
          return;
        }
        await delay(250);
      }
      throw new Error(`Timed out waiting for ${pattern}. Recent output:\n${tail(output)}`);
    },
  };
}

export async function killTcpPort(port: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }

  for (const signal of ['-TERM', '-KILL']) {
    try {
      execFileSync('fuser', ['-k', signal, `${port}/tcp`], { stdio: 'ignore' });
    } catch (err) {
      void err;
    }
    await delay(500);
  }
}

export async function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status >= 200 && response.status < 500) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}
