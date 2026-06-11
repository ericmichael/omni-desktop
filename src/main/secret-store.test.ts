/**
 * LocalSecretStore — AES roundtrip, cross-shell sharing (two instances on the
 * same dir, as desktop + local-server do), and back-compat reads of the legacy
 * Electron `{v, enc}` envelope.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalSecretStore } from '@/main/secret-store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-secrets-'));
  delete process.env.OMNI_SECRET_KEY; // use a generated secret.key under `dir`
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LocalSecretStore', () => {
  it('round-trips a git token (encrypted at rest, not plaintext on disk)', async () => {
    const store = new LocalSecretStore(dir);
    await store.setGitToken('github-oauth', 'ghp_secret123');

    expect(await store.getGitToken('github-oauth')).toBe('ghp_secret123');
    const raw = readFileSync(join(dir, 'git-secrets.json'), 'utf-8');
    expect(raw).not.toContain('ghp_secret123'); // AES, not plaintext
    expect(JSON.parse(raw).gitTokens['github-oauth']).toHaveProperty('iv');
  });

  it('shares the file across instances (desktop ↔ local-server)', async () => {
    await new LocalSecretStore(dir).setGitToken('c1', 'tok-1');
    // A second instance on the same dir (the other shell) reads it back.
    expect(await new LocalSecretStore(dir).getGitToken('c1')).toBe('tok-1');
  });

  it('reads a legacy enc:false (base64 plaintext) entry written by the old desktop store', async () => {
    writeFileSync(
      join(dir, 'git-secrets.json'),
      JSON.stringify({
        gitTokens: { 'github-oauth': { v: Buffer.from('gho_legacy').toString('base64'), enc: false } },
        oauthTokens: {},
      })
    );
    expect(await new LocalSecretStore(dir).getGitToken('github-oauth')).toBe('gho_legacy');
  });

  it('cannot read a legacy enc:true entry (safeStorage-encrypted) and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(
      join(dir, 'git-secrets.json'),
      JSON.stringify({ gitTokens: { x: { v: 'AAAA', enc: true } }, oauthTokens: {} })
    );
    expect(await new LocalSecretStore(dir).getGitToken('x')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('a write upgrades the file to the AES format in place', async () => {
    writeFileSync(
      join(dir, 'git-secrets.json'),
      JSON.stringify({ gitTokens: { a: { v: Buffer.from('old').toString('base64'), enc: false } }, oauthTokens: {} })
    );
    const store = new LocalSecretStore(dir);
    await store.setGitToken('b', 'new'); // touches the file
    const data = JSON.parse(readFileSync(join(dir, 'git-secrets.json'), 'utf-8'));
    expect(data.gitTokens.a).toEqual({ v: Buffer.from('old').toString('base64'), enc: false }); // untouched legacy
    expect(data.gitTokens.b).toHaveProperty('iv'); // new entry is AES
    expect(await store.getGitToken('a')).toBe('old'); // still readable
  });

  it('delete removes a git token', async () => {
    const store = new LocalSecretStore(dir);
    await store.setGitToken('c', 'v');
    await store.deleteGitToken('c');
    expect(await store.getGitToken('c')).toBeUndefined();
  });

  it('round-trips oauth bundles in a separate slot', () => {
    const store = new LocalSecretStore(dir);
    store.setOauthTokens('entra', { access: 'a', refresh: 'r', expires: 123 });
    expect(store.getOauthTokens('entra')).toEqual({ access: 'a', refresh: 'r', expires: 123 });
    // git + oauth slots are independent.
    expect(store.getOauthTokens('nope')).toBeUndefined();
    store.deleteOauthTokens('entra');
    expect(store.getOauthTokens('entra')).toBeUndefined();
  });

  it('honors OMNI_SECRET_KEY when set', async () => {
    process.env.OMNI_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
    const store = new LocalSecretStore(dir);
    await store.setGitToken('k', 'val');
    expect(await store.getGitToken('k')).toBe('val');
  });
});
