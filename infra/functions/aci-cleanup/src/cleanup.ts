/**
 * Pure cleanup logic — separated from the Function entry-point so it can be
 * unit-tested with an injected SDK.
 *
 * Identification: a group belongs to this deployment if its ``omni-launcher``
 * tag matches the configured ``launcherTag`` (defaults to the RG name; the
 * omniagents AciContainerEngine sets the tag at create time — see
 * core/sandbox/aci_engine.py).
 *
 * Staleness heuristic: a group is stale if its ``omni-created-at`` tag is
 * older than ``maxAgeHours``. We deliberately don't query the launcher for
 * "active sessions" — this Function runs independently of launcher health
 * (that's the whole point of running out-of-band), so we use the age cutoff
 * as a hard upper bound on session lifetime. Sessions that legitimately need
 * to outlive the bound should snapshot + resume instead.
 *
 * A group missing the ``omni-launcher`` tag is left alone (someone else
 * created it). A group missing ``omni-created-at`` is left alone (created by
 * an older omniagents version that didn't tag — let the operator clean up).
 */

export type GroupSummary = {
  name: string;
  tags?: Record<string, string> | null;
};

export type CleanupResult = {
  total: number;
  deleted: string[];
  skipped: { name: string; reason: string }[];
};

export type CleanupOptions = {
  launcherTag: string;
  maxAgeHours: number;
  now?: Date;
};

export function selectVictims(
  groups: GroupSummary[],
  opts: CleanupOptions,
): CleanupResult {
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - opts.maxAgeHours * 3600 * 1000;
  const deleted: string[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const g of groups) {
    const tags = g.tags ?? {};
    const launcher = tags['omni-launcher'];
    if (launcher !== opts.launcherTag) {
      skipped.push({ name: g.name, reason: `tag omni-launcher!=${opts.launcherTag} (got ${launcher ?? '<missing>'})` });
      continue;
    }
    const createdAt = tags['omni-created-at'];
    if (!createdAt) {
      skipped.push({ name: g.name, reason: 'missing omni-created-at tag' });
      continue;
    }
    const ts = Date.parse(createdAt);
    if (!Number.isFinite(ts)) {
      skipped.push({ name: g.name, reason: `unparseable omni-created-at: ${createdAt}` });
      continue;
    }
    if (ts > cutoff) {
      skipped.push({ name: g.name, reason: `younger than ${opts.maxAgeHours}h (created ${createdAt})` });
      continue;
    }
    deleted.push(g.name);
  }

  return { total: groups.length, deleted, skipped };
}
