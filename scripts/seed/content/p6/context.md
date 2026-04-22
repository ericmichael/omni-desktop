# Platform Oncall

Runbooks + tooling for our on-call rotation. Everything the on-call engineer needs at 3am is in this project.

## Current rotation

- Primary: rotates weekly (see `runbooks/rotation.md` — not yet written, on the backlog).
- Secondary: same schedule, shifted one week.
- Escalation: engineering manager → director → VP.

## Related pages

- **db-failover** — Postgres primary failover (manual + automated).
- **cert-rotation** — Let's Encrypt renewal for edge.internal.
- **noisy-neighbor** — tenant producing disproportionate load; triage + rate-limit.
- **pager-unmute** — PagerDuty mute TTL expired, re-enable cleanly.
