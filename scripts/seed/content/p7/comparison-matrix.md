# Vendor Comparison Matrix

As of week 3 of POC. Updated weekly.

## Features

| Capability           | Relic     | Foresight | Quasar    |
|----------------------|-----------|-----------|-----------|
| Log ingest           | ✅        | ✅        | ✅        |
| Metrics              | ✅        | ✅        | ⚠️ (beta) |
| Traces               | ✅        | ⚠️        | ❌        |
| Alerts               | ✅        | ✅        | ✅        |
| Dashboards as code   | ✅        | ✅        | ❌        |
| SSO (SAML)           | ✅        | ✅ (ent)  | ✅        |
| Data residency       | US, EU    | self-host | US only   |

## Pricing (estimate for our scale)

| Vendor    | Annual     | Notes |
|-----------|------------|-------|
| Relic     | $380k      | Price ladder has a cliff at 10TB/day. |
| Foresight | $95k + ops | Self-host ~ 2 SRE days/month. |
| Quasar    | $60k       | Net-new startup risk. |

## Key gaps

- **Relic**: cost is the deal-breaker. Pushback incoming from finance.
- **Foresight**: traces are a work-in-progress; they promise Q3 GA.
- **Quasar**: no traces, no dashboards-as-code. We'd need to wait out their roadmap.

## Current lean

Foresight + an explicit bet on their Q3 trace GA. Contingency: keep our log pipeline for 6 more months if they slip.
