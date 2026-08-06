/**
 * Parity tests for the product registry: with omni-code as the bundled
 * product, every value resolved through `ProductDefinition` /
 * `ProductRuntimeInfo` must equal the literals the launcher hardcoded
 * before the product-agnostic-host refactor.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { OMNI_CODE_VERSION } from '@/lib/omni-version';
import {
  assertProductServeProtocol,
  BUNDLED_PRODUCT,
  getActiveProduct,
  getProductSlug,
  parseProductDescribePayload,
  setCachedProductRuntimeInfo,
  SUPPORTED_SERVE_PROTOCOL,
} from '@/lib/product';

/**
 * Verbatim payload emitted by `omni describe --json` (omniagents
 * docs/serve-protocol.md, protocol v2) for the pinned omni-code version.
 */
const OMNI_CODE_DESCRIBE = {
  name: 'omni-code',
  prog: 'omni',
  label: 'Omni Code',
  slug: 'omni_code',
  version: '0.6.21',
  config_dir: '/home/user/.config/omni_code',
  env_prefix: 'OMNI_CODE',
  update: {
    index_url: 'https://pypi.fury.io/ericmichael/omni-code/',
    command_hint: 'omni update',
  },
  serve_protocol: 2,
};

afterEach(() => {
  setCachedProductRuntimeInfo(null);
});

describe('bundled ProductDefinition (omni-code parity)', () => {
  it('matches the literals the launcher previously hardcoded', () => {
    expect(BUNDLED_PRODUCT).toEqual({
      packageName: 'omni-code',
      extraIndexUrl: 'https://pypi.fury.io/ericmichael/',
      prog: 'omni',
      pinnedVersion: '0.6.21',
    });
    expect(getActiveProduct()).toBe(BUNDLED_PRODUCT);
  });

  it('OMNI_CODE_VERSION is sourced from the definition pin', () => {
    expect(OMNI_CODE_VERSION).toBe(BUNDLED_PRODUCT.pinnedVersion);
  });

  it('pre-describe slug fallback resolves to the omni_code literal', () => {
    setCachedProductRuntimeInfo(null);
    expect(getProductSlug()).toBe('omni_code');
  });
});

describe('describe --json payload parsing', () => {
  it('parses the omni-code payload into ProductRuntimeInfo', () => {
    const info = parseProductDescribePayload(OMNI_CODE_DESCRIBE);
    expect(info).toEqual({
      name: 'omni-code',
      prog: 'omni',
      label: 'Omni Code',
      slug: 'omni_code',
      version: '0.6.21',
      configDir: '/home/user/.config/omni_code',
      envPrefix: 'OMNI_CODE',
      update: {
        indexUrl: 'https://pypi.fury.io/ericmichael/omni-code/',
        commandHint: 'omni update',
      },
      serveProtocol: 2,
    });
    expect(info.serveProtocol).toBe(SUPPORTED_SERVE_PROTOCOL);
  });

  it('describe values agree with the bundled definition (identity parity)', () => {
    const info = parseProductDescribePayload(OMNI_CODE_DESCRIBE);
    expect(info.name).toBe(BUNDLED_PRODUCT.packageName);
    expect(info.prog).toBe(BUNDLED_PRODUCT.prog);
    expect(info.version).toBe(BUNDLED_PRODUCT.pinnedVersion);
    // The fallback slug derivation and the product-reported slug agree.
    expect(info.slug).toBe(BUNDLED_PRODUCT.packageName.replace(/-/g, '_'));
  });

  it('cached describe slug drives getProductSlug', () => {
    setCachedProductRuntimeInfo(parseProductDescribePayload(OMNI_CODE_DESCRIBE));
    expect(getProductSlug()).toBe('omni_code');
  });

  it('handles a null update channel', () => {
    const info = parseProductDescribePayload({ ...OMNI_CODE_DESCRIBE, update: null });
    expect(info.update).toBeNull();
  });

  it('rejects malformed payloads', () => {
    expect(() => parseProductDescribePayload(null)).toThrow(/did not return an object/);
    expect(() => parseProductDescribePayload({ ...OMNI_CODE_DESCRIBE, slug: undefined })).toThrow(/missing "slug"/);
    expect(() => parseProductDescribePayload({ ...OMNI_CODE_DESCRIBE, serve_protocol: undefined })).toThrow(
      /missing "serve_protocol"/
    );
    expect(() => parseProductDescribePayload({ ...OMNI_CODE_DESCRIBE, serve_protocol: Number.NaN })).toThrow(
      /missing "serve_protocol"/
    );
    expect(() => parseProductDescribePayload({ ...OMNI_CODE_DESCRIBE, serve_protocol: 2.5 })).toThrow(
      /missing "serve_protocol"/
    );
  });
});

describe('serve protocol assertion', () => {
  it('accepts protocol v2', () => {
    expect(() => assertProductServeProtocol(parseProductDescribePayload(OMNI_CODE_DESCRIBE))).not.toThrow();
  });

  it('throws a clear error on mismatch', () => {
    const info = parseProductDescribePayload({ ...OMNI_CODE_DESCRIBE, serve_protocol: 1 });
    expect(() => assertProductServeProtocol(info)).toThrow(/speaks serve protocol v1, but this launcher requires v2/);
  });
});
