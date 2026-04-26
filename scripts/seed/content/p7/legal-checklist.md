# Legal Review Checklist

Must be complete before signing with any vendor.

## Data protection

- [ ] DPA (Data Processing Addendum) executed.
- [ ] Sub-processor list obtained.
- [ ] Data residency matches our policy (EU customer data stays in EU).
- [ ] Right-to-delete operationalized — how do we verify tombstones propagate?

## Security

- [ ] SOC 2 Type II report received (last 12 months).
- [ ] Pen test report reviewed.
- [ ] Incident notification SLA ≤ 72h.

## Contracts

- [ ] Termination clauses: 30-day notice both sides.
- [ ] Price-lock commitment: 3 years, max 5% annual increase.
- [ ] Data export on exit — format + deadline specified.

## Status

| Vendor    | DPA | SOC2 | Contract |
|-----------|-----|------|----------|
| Relic     | ✅  | ✅   | 🟡 (legal has red-lines) |
| Foresight | ✅  | ✅   | 🟡 (open-core licensing questions) |
| Quasar    | ⚠️  | ❌   | Blocked on SOC2 — they don't have one yet. |
