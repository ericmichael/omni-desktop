/**
 * Timer-triggered Azure Function that deletes orphaned ACI sandboxes.
 *
 * Runs independently of the launcher's health — survives launcher
 * crashloops, restarts, and the launcher-was-redeployed-and-forgot
 * scenarios that have actually bitten this deployment. The cleanup logic
 * itself lives in ../cleanup.ts; this file is only the SDK wiring.
 *
 * Env vars:
 *   AZURE_SUBSCRIPTION_ID    target subscription (set by bicep)
 *   AZURE_RESOURCE_GROUP     RG containing the ACI groups (set by bicep)
 *   OMNI_LAUNCHER_TAG        match value for the ``omni-launcher`` tag
 *                            (defaults to RG name — same default as omniagents
 *                            sets at create time)
 *   MAX_AGE_HOURS            stale-threshold in hours (default 8)
 *   AZURE_CLIENT_ID          user-assigned MI client id (set by bicep so
 *                            DefaultAzureCredential picks the right MI)
 */

import { ContainerInstanceManagementClient } from '@azure/arm-containerinstance';
import type { InvocationContext, Timer } from '@azure/functions';
import { app } from '@azure/functions';
import { DefaultAzureCredential } from '@azure/identity';

import { type GroupSummary, selectVictims } from '../cleanup.js';

export async function aciCleanup(myTimer: Timer, ctx: InvocationContext): Promise<void> {
  const subscriptionId = mustEnv('AZURE_SUBSCRIPTION_ID');
  const resourceGroup = mustEnv('AZURE_RESOURCE_GROUP');
  const launcherTag = process.env['OMNI_LAUNCHER_TAG'] ?? resourceGroup;
  const maxAgeHours = Number(process.env['MAX_AGE_HOURS'] ?? '8');

  const cred = new DefaultAzureCredential();
  const client = new ContainerInstanceManagementClient(cred, subscriptionId);

  const groups: GroupSummary[] = [];
  for await (const g of client.containerGroups.listByResourceGroup(resourceGroup)) {
    if (!g.name) {
      continue;
    }
    groups.push({ name: g.name, tags: g.tags ?? null });
  }

  const result = selectVictims(groups, { launcherTag, maxAgeHours });
  ctx.log(`[aci-cleanup] total=${result.total} stale=${result.deleted.length} skipped=${result.skipped.length}`);

  // Delete in parallel. Catch per-group so one stuck delete doesn't block the
  // rest. ``beginDeleteAndWait`` polls until the operation actually completes,
  // so the Function's next invocation won't redundantly try to delete the
  // same group while a prior delete is still draining.
  const outcomes = await Promise.allSettled(
    result.deleted.map(async (name) => {
      ctx.log(`[aci-cleanup] deleting ${name}`);
      await client.containerGroups.beginDeleteAndWait(resourceGroup, name);
    })
  );
  const failures = outcomes
    .map((o, i) => ({ outcome: o, name: result.deleted[i] }))
    .filter((x): x is { outcome: PromiseRejectedResult; name: string } => x.outcome.status === 'rejected');
  for (const f of failures) {
    ctx.error(`[aci-cleanup] delete failed for ${f.name}: ${String(f.outcome.reason)}`);
  }
  ctx.log(`[aci-cleanup] done deleted=${result.deleted.length - failures.length}/${result.deleted.length}`);
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`[aci-cleanup] required env var ${name} is not set`);
  }
  return v;
}

// Register with the Functions host. Schedule: every 30 minutes at :00 and :30.
// runOnStartup=true so a freshly-deployed Function picks up existing orphans
// without waiting half an hour.
app.timer('aciCleanup', {
  schedule: '0 0,30 * * * *',
  runOnStartup: true,
  handler: aciCleanup,
});
