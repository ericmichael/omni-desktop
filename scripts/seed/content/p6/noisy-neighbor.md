# Runbook — Noisy Neighbor

When you're paged for `api-latency-p99 > 2s` and a single tenant is producing most of the load.

## Identify the tenant

```bash
./scripts/top_tenants.sh --window 5m --metric qps
```

Expect a tenant producing > 40% of QPS.

## Decide

- **Unintentional (bot loop, runaway batch)**: rate-limit at the gateway, page their account rep.
- **Expected (new integration, traffic spike)**: let it ride if the system is keeping up; otherwise same rate-limit with warning.
- **Abuse**: escalate to security. Do not rate-limit — security prefers we not tip them off.

## Apply rate-limit

```bash
./scripts/apply_ratelimit.sh --tenant <tenant-id> --qps 50 --ttl 2h
```

TTL auto-expires; no need to manually remove.

## After

- Slack the tenant's account rep (see `runbooks/contacts.md`).
- File an incident if latency crossed SLO.
