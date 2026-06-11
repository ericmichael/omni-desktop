# Runbook — DB Failover

When you're paged for `pg-primary-down` or sustained `pg-lag > 10s`.

## Assess (2 min)

1. Check `grafana.internal/d/pg-primary` — is the primary actually down or just slow?
2. Check `#oncall` Slack — maybe someone is already on it.
3. Check deploys in last 30m — `kubectl -n db rollout history statefulset/postgres-primary`.

## Decide

- **Transient slowness** (< 60s, CPU normal): do nothing; watch 5 more minutes.
- **Primary unreachable**: promote secondary.
- **Deployed regression**: roll back the deploy; failover is a last resort.

## Promote secondary

```bash
./scripts/pg_failover.sh --from pg-0 --to pg-1 --confirm
```

The script:
1. Stops writes at the proxy (30s drain).
2. Promotes pg-1 to primary.
3. Updates service endpoints.
4. Restarts replication on pg-0 as a new replica.

**Expected downtime**: ~90s of writes, reads unaffected.

## After

- File an incident in Jira.
- Post summary in `#oncall` within 30 min of resolution.
- Open a ticket on **Q2 runbook audit** if any step was unclear.
