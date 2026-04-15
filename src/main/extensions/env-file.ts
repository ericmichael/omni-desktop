import { promises as fs } from 'fs';
import path from 'path';

import { getOmniConfigDir } from '@/main/util';

/**
 * Parse a launcher .env file (Settings → Environment writes this format):
 * one `KEY=VALUE` per line, blank lines and `#` comments ignored. Keys with
 * no `=` sign are skipped. No quote handling — the launcher's own UI parser
 * doesn't strip quotes either, so what the user types is what they get.
 */
export const parseEnvFile = (content: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
continue;
}
    const eqIdx = raw.indexOf('=');
    if (eqIdx === -1) {
continue;
}
    const key = raw.slice(0, eqIdx).trim();
    if (!key) {
continue;
}
    result[key] = raw.slice(eqIdx + 1).replace(/\r$/, '');
  }
  return result;
};

/**
 * Read the launcher's user-managed env file at `<omniConfigDir>/.env` and
 * return its keys as a plain object. Returns an empty object if the file
 * doesn't exist or can't be read — callers treat absence as "no extra env".
 */
export const loadOmniEnvFile = async (): Promise<Record<string, string>> => {
  const filePath = path.join(getOmniConfigDir(), '.env');
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return parseEnvFile(content);
  } catch {
    return {};
  }
};
