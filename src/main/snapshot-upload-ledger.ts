import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getSnapshotStore, type SnapshotStore } from '@/main/snapshot-blob-store';

const LEDGER_VERSION = 1;
const LEDGER_FILENAME = '.snapshot-upload-ledger.json';
const MAX_LEDGER_ENTRIES = 512;
const MAX_ATTEMPTS = 32;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;
const SAFE_SNAPSHOT_REF = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,199})$/;

export type SnapshotUploadDisposition = 'retryable' | 'forced-uncertain';

export type PendingSnapshotUpload = {
  snapshotRef: string;
  disposition: SnapshotUploadDisposition;
  attempts: number;
  queuedAt: number;
  updatedAt: number;
  nextAttemptAt: number;
};

type SnapshotUploadLedger = {
  version: 1;
  entries: PendingSnapshotUpload[];
};

type LedgerRead = { ok: true; ledger: SnapshotUploadLedger } | { ok: false; ledger: SnapshotUploadLedger };

export type SnapshotUploadReconcileResult = {
  attempted: number;
  persisted: string[];
  retryable: string[];
  forcedUncertain: string[];
};

const emptyLedger = (): SnapshotUploadLedger => ({ version: LEDGER_VERSION, entries: [] });

const ledgerPath = (snapshotDir: string): string => path.join(snapshotDir, LEDGER_FILENAME);

const isSafeSnapshotRef = (value: unknown): value is string =>
  typeof value === 'string' && SAFE_SNAPSHOT_REF.test(value) && !value.includes('..');

const finiteTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const decodeEntry = (value: unknown): PendingSnapshotUpload | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const disposition = entry.disposition;
  if (
    !isSafeSnapshotRef(entry.snapshotRef) ||
    (disposition !== 'retryable' && disposition !== 'forced-uncertain') ||
    !Number.isSafeInteger(entry.attempts) ||
    (entry.attempts as number) < 0 ||
    !finiteTimestamp(entry.queuedAt) ||
    !finiteTimestamp(entry.updatedAt) ||
    !finiteTimestamp(entry.nextAttemptAt)
  ) {
    return null;
  }
  return {
    snapshotRef: entry.snapshotRef,
    disposition,
    attempts: Math.min(entry.attempts as number, MAX_ATTEMPTS),
    queuedAt: entry.queuedAt,
    updatedAt: entry.updatedAt,
    nextAttemptAt: entry.nextAttemptAt,
  };
};

const readLedger = (snapshotDir: string): LedgerRead => {
  const target = ledgerPath(snapshotDir);
  if (!existsSync(target)) {
    return { ok: true, ledger: emptyLedger() };
  }
  try {
    const raw = JSON.parse(readFileSync(target, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, ledger: emptyLedger() };
    }
    const record = raw as Record<string, unknown>;
    if (record.version !== LEDGER_VERSION || !Array.isArray(record.entries)) {
      return { ok: false, ledger: emptyLedger() };
    }
    const entries = record.entries.map(decodeEntry);
    if (entries.some((entry) => entry === null) || entries.length > MAX_LEDGER_ENTRIES) {
      return { ok: false, ledger: emptyLedger() };
    }
    const unique = new Map<string, PendingSnapshotUpload>();
    for (const entry of entries as PendingSnapshotUpload[]) {
      const previous = unique.get(entry.snapshotRef);
      unique.set(entry.snapshotRef, {
        ...entry,
        disposition: previous?.disposition === 'forced-uncertain' ? 'forced-uncertain' : entry.disposition,
      });
    }
    return { ok: true, ledger: { version: LEDGER_VERSION, entries: [...unique.values()] } };
  } catch {
    // Fail closed: never overwrite a corrupt ledger and erase evidence of an
    // uncertain snapshot. A later repair can inspect the untouched file.
    return { ok: false, ledger: emptyLedger() };
  }
};

const writeLedger = (snapshotDir: string, ledger: SnapshotUploadLedger): void => {
  mkdirSync(snapshotDir, { recursive: true });
  const target = ledgerPath(snapshotDir);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(ledger), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, target);
  chmodSync(target, 0o600);
};

const retryDelay = (attempts: number): number =>
  Math.min(BASE_RETRY_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 4), MAX_RETRY_MS);

export const recordPendingSnapshotUpload = (
  snapshotRef: string,
  snapshotDir: string,
  disposition: SnapshotUploadDisposition,
  now = Date.now()
): boolean => {
  if (!isSafeSnapshotRef(snapshotRef)) {
    return false;
  }
  const loaded = readLedger(snapshotDir);
  if (!loaded.ok) {
    return false;
  }
  const existing = loaded.ledger.entries.find((entry) => entry.snapshotRef === snapshotRef);
  if (!existing && loaded.ledger.entries.length >= MAX_LEDGER_ENTRIES) {
    return false;
  }
  const attempts = Math.min((existing?.attempts ?? 0) + 1, MAX_ATTEMPTS);
  const next: PendingSnapshotUpload = {
    snapshotRef,
    disposition:
      disposition === 'forced-uncertain' || existing?.disposition === 'forced-uncertain'
        ? 'forced-uncertain'
        : 'retryable',
    attempts,
    queuedAt: existing?.queuedAt ?? now,
    updatedAt: now,
    nextAttemptAt: now + retryDelay(attempts),
  };
  loaded.ledger.entries = existing
    ? loaded.ledger.entries.map((entry) => (entry.snapshotRef === snapshotRef ? next : entry))
    : [...loaded.ledger.entries, next];
  try {
    writeLedger(snapshotDir, loaded.ledger);
    return true;
  } catch {
    return false;
  }
};

export const completePendingSnapshotUpload = (snapshotRef: string, snapshotDir: string): boolean => {
  if (!isSafeSnapshotRef(snapshotRef)) {
    return false;
  }
  const loaded = readLedger(snapshotDir);
  if (!loaded.ok) {
    return false;
  }
  const next = loaded.ledger.entries.filter((entry) => entry.snapshotRef !== snapshotRef);
  if (next.length === loaded.ledger.entries.length) {
    return true;
  }
  try {
    writeLedger(snapshotDir, { version: LEDGER_VERSION, entries: next });
    return true;
  } catch {
    return false;
  }
};

export const listPendingSnapshotUploads = (snapshotDir: string): PendingSnapshotUpload[] => {
  const loaded = readLedger(snapshotDir);
  if (!loaded.ok) {
    throw new Error(`Snapshot upload ledger is invalid: ${ledgerPath(snapshotDir)}`);
  }
  return loaded.ledger.entries.map((entry) => ({ ...entry }));
};

export const reconcilePendingSnapshotUploads = async (
  snapshotDir: string,
  opts: { store?: SnapshotStore; now?: number; force?: boolean } = {}
): Promise<SnapshotUploadReconcileResult> => {
  const loaded = readLedger(snapshotDir);
  if (!loaded.ok) {
    throw new Error(`Snapshot upload ledger is invalid: ${ledgerPath(snapshotDir)}`);
  }
  const store = opts.store ?? getSnapshotStore();
  const now = opts.now ?? Date.now();
  const persisted: string[] = [];
  let attempted = 0;
  for (const entry of [...loaded.ledger.entries]) {
    if (entry.disposition !== 'retryable' || (!opts.force && entry.nextAttemptAt > now)) {
      continue;
    }
    attempted += 1;
    let durable = false;
    try {
      durable =
        (await store.verify(entry.snapshotRef, snapshotDir)) && (await store.push(entry.snapshotRef, snapshotDir));
    } catch {
      durable = false;
    }
    if (durable) {
      loaded.ledger.entries = loaded.ledger.entries.filter((item) => item.snapshotRef !== entry.snapshotRef);
      persisted.push(entry.snapshotRef);
      continue;
    }
    const attempts = Math.min(entry.attempts + 1, MAX_ATTEMPTS);
    loaded.ledger.entries = loaded.ledger.entries.map((item) =>
      item.snapshotRef === entry.snapshotRef
        ? { ...item, attempts, updatedAt: now, nextAttemptAt: now + retryDelay(attempts) }
        : item
    );
  }
  writeLedger(snapshotDir, loaded.ledger);
  return {
    attempted,
    persisted,
    retryable: loaded.ledger.entries
      .filter((entry) => entry.disposition === 'retryable')
      .map((entry) => entry.snapshotRef),
    forcedUncertain: loaded.ledger.entries
      .filter((entry) => entry.disposition === 'forced-uncertain')
      .map((entry) => entry.snapshotRef),
  };
};
