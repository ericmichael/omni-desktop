# Runbook — Cert Rotation

When you're paged for `cert-expiring-soon` (< 14 days) or `cert-expired`.

## Normal case (automated)

`cert-manager` handles renewal for `*.edge.internal`. If it's working, you'll never be paged — this runbook is for when it isn't.

## Check cert-manager health

```bash
kubectl -n cert-manager get pods
kubectl -n cert-manager describe certificate edge-internal-tls
```

Look for `Ready: True`. If `False`, read `Events:` and match the error below.

## Common failures

- **Rate-limited by Let's Encrypt**: wait out the window (see `ratelimit.md` — not yet written). Do NOT bump the renewal interval to be aggressive; that's what got us rate-limited.
- **DNS propagation**: the ACME DNS-01 challenge can take 2–5 min. Not an error unless > 15 min.
- **ACME account deactivated**: someone revoked the key. File a ticket immediately; bring in the platform lead.

## Manual renewal (break-glass)

```bash
./scripts/renew_cert.sh edge-internal-tls --force
```

This bypasses cert-manager and calls Let's Encrypt directly. Use only if automation is fully broken.
