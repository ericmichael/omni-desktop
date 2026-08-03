/**
 * Product registry — the launcher as a product-agnostic host for
 * omniagents products.
 *
 * Two layers of product knowledge:
 *
 *   1. `ProductDefinition` — install-time facts the launcher must know
 *      BEFORE the product is installed (what to `uv pip install`, from
 *      which index, what the CLI binary is called, which version to pin).
 *      Bundled with the launcher; today there is exactly one entry.
 *
 *   2. `ProductRuntimeInfo` — runtime facts reported by the installed
 *      product itself via `<prog> describe --json` (see omniagents
 *      `docs/serve-protocol.md`, protocol v2): slug, config dir, label,
 *      version, env prefix, serve protocol. Cached per process
 *      (`setCachedProductRuntimeInfo`, refreshed after installs by
 *      `src/main/product-runtime.ts`).
 *
 * This module is pure (no Electron/node imports) so it is shared by the
 * main process, the server build, and unit tests.
 */

/** Install-time facts the launcher must know before the product is installed. */
export type ProductDefinition = {
  /** pip distribution name (`uv pip install <packageName>==<pinnedVersion>`). */
  packageName: string;
  /** Extra package index URL the distribution is published to. */
  extraIndexUrl: string;
  /** Console-script / CLI binary name inside the venv (`bin/<prog>`). */
  prog: string;
  /** Product version this launcher build pins and checks against. */
  pinnedVersion: string;
};

/**
 * The single bundled product. Values are the constants this launcher
 * shipped with historically — parity is pinned by `src/lib/product.test.ts`.
 */
export const BUNDLED_PRODUCT: ProductDefinition = {
  packageName: 'omni-code',
  extraIndexUrl: 'https://pypi.fury.io/ericmichael/',
  prog: 'omni',
  pinnedVersion: '0.6.19',
};

/** The product this launcher instance hosts. */
export const getActiveProduct = (): ProductDefinition => BUNDLED_PRODUCT;

/**
 * Serve-protocol version this launcher targets. Contract: omniagents
 * `docs/serve-protocol.md` (`omniagents.product_serve.SERVE_PROTOCOL_VERSION`).
 */
export const SUPPORTED_SERVE_PROTOCOL = 2;

/** Runtime facts reported by `<prog> describe --json` from the installed venv. */
export type ProductRuntimeInfo = {
  /** Distribution name (mirrors `ProductDefinition.packageName`). */
  name: string;
  /** CLI program name (mirrors `ProductDefinition.prog`). */
  prog: string;
  /** Human display label, e.g. "Omni Code". */
  label: string;
  /** Platform identity slug, e.g. "omni_code" — policy, agentSlug, originator. */
  slug: string;
  /** Installed product package version. */
  version: string;
  /** Resolved absolute config directory of the installed product. */
  configDir: string;
  /** Env-var prefix, e.g. "OMNI_CODE". */
  envPrefix: string;
  /** Self-update channel, or null when the product has none. */
  update: { indexUrl: string; commandHint: string } | null;
  /** Version of the serve contract the installation speaks. */
  serveProtocol: number;
};

/**
 * Validate + normalize the JSON object printed by `<prog> describe --json`
 * into a `ProductRuntimeInfo`. Throws on a malformed payload.
 */
export const parseProductDescribePayload = (raw: unknown): ProductRuntimeInfo => {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('describe --json did not return an object');
  }
  const obj = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const v = obj[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`describe --json payload is missing "${key}"`);
    }
    return v;
  };
  const serveProtocol = obj['serve_protocol'];
  if (typeof serveProtocol !== 'number') {
    throw new Error('describe --json payload is missing "serve_protocol"');
  }
  let update: ProductRuntimeInfo['update'] = null;
  if (obj['update'] !== null && obj['update'] !== undefined) {
    const u = obj['update'] as Record<string, unknown>;
    update = {
      indexUrl: typeof u['index_url'] === 'string' ? u['index_url'] : '',
      commandHint: typeof u['command_hint'] === 'string' ? u['command_hint'] : '',
    };
  }
  return {
    name: str('name'),
    prog: str('prog'),
    label: str('label'),
    slug: str('slug'),
    version: str('version'),
    configDir: str('config_dir'),
    envPrefix: str('env_prefix'),
    update,
    serveProtocol,
  };
};

/**
 * Throw a clear error when the installed product speaks a different serve
 * protocol than this launcher targets. Called at session start.
 */
export const assertProductServeProtocol = (info: ProductRuntimeInfo): void => {
  if (info.serveProtocol !== SUPPORTED_SERVE_PROTOCOL) {
    throw new Error(
      `Installed ${info.label} (${info.name} ${info.version}) speaks serve protocol ` +
        `v${info.serveProtocol}, but this launcher requires v${SUPPORTED_SERVE_PROTOCOL} ` +
        `(omniagents docs/serve-protocol.md). ` +
        `Update ${info.serveProtocol < SUPPORTED_SERVE_PROTOCOL ? info.label : 'the launcher'} to a compatible version.`
    );
  }
};

// ---------------------------------------------------------------------------
// Per-process runtime-info cache
// ---------------------------------------------------------------------------

let cachedRuntimeInfo: ProductRuntimeInfo | null = null;

/** Last `describe --json` result for this process, or null before introspection. */
export const getCachedProductRuntimeInfo = (): ProductRuntimeInfo | null => cachedRuntimeInfo;

/** Store (or clear) the runtime info. Written by `src/main/product-runtime.ts`. */
export const setCachedProductRuntimeInfo = (info: ProductRuntimeInfo | null): void => {
  cachedRuntimeInfo = info;
};

/**
 * The product's platform identity slug — used for policy lookups, the
 * default agentSlug, and the Codex OAuth originator. Authoritative value
 * comes from `describe --json`; before the product is installed we fall
 * back to the conventional derivation (distribution name with `-` → `_`),
 * which resolves to the same value for a convention-following product.
 */
export const getProductSlug = (): string => {
  return cachedRuntimeInfo?.slug ?? getActiveProduct().packageName.replace(/-/g, '_');
};
