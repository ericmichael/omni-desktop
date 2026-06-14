import { describe, expect, it } from 'vitest';

import {
  containsEnvRef,
  emptyMcpConfig,
  emptyModelsConfig,
  emptyNetworkConfig,
  parseEnvVars,
} from '@/lib/agent-config';

describe('parseEnvVars', () => {
  it('parses KEY=value, skipping comments and blanks', () => {
    expect(parseEnvVars('# comment\n\nFOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('keeps everything after the first = (values may contain =)', () => {
    expect(parseEnvVars('URL=https://x?a=1&b=2')).toEqual({ URL: 'https://x?a=1&b=2' });
  });

  it('trims the key but not the value, and skips keyless lines', () => {
    expect(parseEnvVars('  KEY =  spaced \nnoequalshere\n=novalue')).toEqual({ KEY: '  spaced ' });
  });
});

describe('containsEnvRef', () => {
  it('detects ${VAR} and ${VAR:-default}', () => {
    expect(containsEnvRef('${OPENAI_KEY}')).toBe(true);
    expect(containsEnvRef('Bearer ${TOK:-none}')).toBe(true);
  });
  it('is false for plain values', () => {
    expect(containsEnvRef('sk-abc123')).toBe(false);
  });
});

describe('empty config factories', () => {
  it('produce schema-valid empties', () => {
    expect(emptyModelsConfig()).toEqual({ version: 3, default: null, voice_default: null, providers: {} });
    expect(emptyMcpConfig()).toEqual({ mcpServers: {} });
    expect(emptyNetworkConfig().enabled).toBe(false);
  });
});
