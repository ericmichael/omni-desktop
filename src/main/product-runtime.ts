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
  getActiveProduct,
  getCachedProductRuntimeInfo,
  parseProductDescribePayload,
  type ProductRuntimeInfo,
  setCachedProductRuntimeInfo,
  SUPPORTED_SERVE_PROTOCOL,
} from '@/lib/product';
import { getOmniCliPath, pathExists } from '@/main/util';

const execFileAsync = promisify(execFile);

export const PRODUCT_DESCRIBE_TIMEOUT_MS = 15_000;

let inflight: Promise<ProductRuntimeInfo | null> | null = null;
let lastIntrospectionError: Error | null = null;

const describeFailure = (cli: string, err: unknown): Error => {
  const cause = err instanceof Error ? err : new Error(String(err));
  const timedOut = (cause as NodeJS.ErrnoException).code === 'ETIMEDOUT' || /timed?\s*out|timeout/i.test(cause.message);
  const detail = timedOut
    ? `timed out after ${PRODUCT_DESCRIBE_TIMEOUT_MS / 1_000} seconds`
    : `failed: ${cause.message}`;

  return new Error(
    `Installed ${getActiveProduct().packageName} cannot be started because \`${cli} describe --json\` ${detail}. ` +
      `Omni Desktop requires a runtime that reports Serve Protocol v${SUPPORTED_SERVE_PROTOCOL}. ` +
      `Reinstall or update ${getActiveProduct().packageName}, then try again.`,
    { cause }
  );
};

/**
 * Run `<prog> describe --json` and refresh the cache. Returns null only
 * when the product CLI is not installed or introspection failed. Failures
 * clear previously cached data so callers can never start from stale,
 * known-good identity after the installed runtime has changed.
 */
const inspectProductRuntime = async (): Promise<ProductRuntimeInfo | null> => {
  const cli = getOmniCliPath();
  if (!(await pathExists(cli))) {
    setCachedProductRuntimeInfo(null);
    lastIntrospectionError = null;
    return null;
  }
  try {
    const { stdout } = await execFileAsync(cli, ['describe', '--json'], { timeout: PRODUCT_DESCRIBE_TIMEOUT_MS });
    const info = parseProductDescribePayload(JSON.parse(stdout) as unknown);
    setCachedProductRuntimeInfo(info);
    lastIntrospectionError = null;
    return info;
  } catch (err) {
    setCachedProductRuntimeInfo(null);
    lastIntrospectionError = describeFailure(cli, err);
    console.warn(`[product] ${lastIntrospectionError.message}`);
    return null;
  }
};

export const refreshProductRuntimeInfo = async (): Promise<ProductRuntimeInfo | null> => {
  inflight ??= inspectProductRuntime().finally(() => {
    inflight = null;
  });
  return inflight;
};

/** Cached runtime info, introspecting the installed CLI on first use. */
export const getProductRuntimeInfo = async (): Promise<ProductRuntimeInfo | null> => {
  const cached = getCachedProductRuntimeInfo();
  if (cached) {
    return cached;
  }
  return refreshProductRuntimeInfo();
};

/**
 * Assert the installed product speaks the serve protocol this launcher
 * targets. A missing CLI is the only no-op: once a runtime is installed,
 * missing/malformed/timed-out introspection and protocol mismatches fail
 * closed before `serve` is spawned.
 */
export const assertServeProtocolSupported = async (): Promise<void> => {
  // Re-run introspection at every serve preflight. The installed runtime
  // may have changed since app startup or since a previous session.
  const info = await refreshProductRuntimeInfo();
  if (info) {
    assertProductServeProtocol(info);
    return;
  }
  if (lastIntrospectionError) {
    throw lastIntrospectionError;
  }
};
