# platform-oncall-runbooks

Runbooks, scripts, and tooling for the platform oncall rotation.

## Layout

- `runbooks/` — one Markdown file per incident class. Oncall opens these first.
- `scripts/` — helper scripts referenced from runbooks (failover, cert rotation, etc.).

## Who uses this

The on-call engineer. If you're reading this during an incident, start with the runbook for your alert, not this README.

## Contributing

After any incident, open a ticket on the **Q2 runbook audit** milestone to capture the gap. Don't patch silently.
