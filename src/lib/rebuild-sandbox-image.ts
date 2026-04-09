import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { promisify } from 'util';

import { OMNI_CODE_VERSION } from '@/lib/omni-version';

const execFileAsync = promisify(execFile);

/**
 * Compute the image tag the omni CLI expects: `omni-code-sandbox:{version}-{hash}`.
 * Must match `_sandbox_image_tag()` in omni-code's `sandbox_cli.py`.
 */
function sandboxImageTag(dockerfilePath: string): string {
  try {
    const digest = createHash('sha256').update(readFileSync(dockerfilePath)).digest('hex').slice(0, 12);
    return `omni-code-sandbox:${OMNI_CODE_VERSION}-${digest}`;
  } catch {
    return `omni-code-sandbox:${OMNI_CODE_VERSION}`;
  }
}

/**
 * Build (or rebuild) the sandbox Docker/Podman image from the Dockerfile.
 * This is independent of any running container — it just builds the image.
 */
export async function rebuildSandboxImage(opts: {
  backend: 'docker' | 'podman';
  dockerfilePath: string;
  contextDir: string;
}): Promise<{ success: boolean; error?: string }> {
  const { backend, dockerfilePath, contextDir } = opts;
  const tag = sandboxImageTag(dockerfilePath);

  try {
    await execFileAsync(backend, [
      'build',
      '--no-cache',
      '-t', tag,
      '--build-arg', `OMNI_CODE_VERSION=${OMNI_CODE_VERSION}`,
      '-f', dockerfilePath,
      contextDir,
    ], { timeout: 600_000 }); // 10 min timeout

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
