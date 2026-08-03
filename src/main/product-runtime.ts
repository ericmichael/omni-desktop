/**
 * Product introspection — invokes `<prog> describe --json` from the
 * installed venv and populates the per-process `ProductRuntimeInfo` cache
 * in `src/lib/product.ts` (which config-dir/slug consumers read).
 *
 * Refresh points:
 *   - lazily at session start (`assertServeProtocolSupported`), and
 *   - after every successful install (`OmniInstallManager`), so a version
 *     change is picked up without restarting the launcher.
 *
 * Contract: omniagents `docs/serve-protocol.md`, protocol v2.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  assertProductServeProtocol,
  getCachedProductRuntimeInfo,
  parseProductDescribePayload,
  type ProductRuntimeInfo,
  setCachedProductRuntimeInfo,
} from '@/lib/product';
import { getOmniCliPath, pathExists } from '@/main/util';

const execFileAsync = promisify(execFile);

const DESCRIBE_TIMEOUT_MS = 15_000;

/**
 * Run `<prog> describe --json` and refresh the cache. Returns null when
 * the product CLI is not installed yet; keeps the previous cache entry
 * when the invocation itself fails (transient errors shouldn't wipe
 * known-good identity data).
 */
export const refreshProductRuntimeInfo = async (): Promise<ProductRuntimeInfo | null> => {
  const cli = getOmniCliPath();
  if (!(await pathExists(cli))) {
    setCachedProductRuntimeInfo(null);
    return null;
  }
  try {
    const { stdout } = await execFileAsync(cli, ['describe', '--json'], { timeout: DESCRIBE_TIMEOUT_MS });
    const info = parseProductDescribePayload(JSON.parse(stdout) as unknown);
    setCachedProductRuntimeInfo(info);
    return info;
  } catch (err) {
    console.warn(`[product] "${cli} describe --json" failed:`, (err as Error).message);
    return getCachedProductRuntimeInfo();
  }
};

let inflight: Promise<ProductRuntimeInfo | null> | null = null;

/** Cached runtime info, introspecting the installed CLI on first use. */
export const getProductRuntimeInfo = async (): Promise<ProductRuntimeInfo | null> => {
  const cached = getCachedProductRuntimeInfo();
  if (cached) {
    return cached;
  }
  inflight ??= refreshProductRuntimeInfo().finally(() => {
    inflight = null;
  });
  return inflight;
};

/**
 * Assert the installed product speaks the serve protocol this launcher
 * targets. Throws a clear, actionable error on mismatch; a no-op when the
 * product can't be introspected (older products without `describe` keep
 * working — the readiness parse will surface real incompatibilities).
 */
export const assertServeProtocolSupported = async (): Promise<void> => {
  const info = await getProductRuntimeInfo();
  if (info) {
    assertProductServeProtocol(info);
  }
};
