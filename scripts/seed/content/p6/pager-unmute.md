# Runbook — Pager Unmute

When PagerDuty has a muted service whose TTL expired and the mute wasn't renewed.

## Why this exists

We mute known-flaky alerts during planned maintenance. If the mute TTL expires and the underlying fix isn't in yet, we get a wake-up page for a known issue.

## Check the mute history

```bash
./scripts/pd_mute_history.sh --service <service-id> --last 30d
```

## Decide

- **Fix is merged + deployed**: unmute; close this page.
- **Fix is merged, not deployed**: keep muted for 24h more; open a ticket to deploy.
- **Fix not merged**: keep muted for 7 days more; ping the owner.

## Unmute

```bash
./scripts/pd_unmute.sh --service <service-id>
```

## Prevent recurrence

- Never set an open-ended mute — always a TTL.
- Link the mute to a ticket in description so oncall sees the context.
