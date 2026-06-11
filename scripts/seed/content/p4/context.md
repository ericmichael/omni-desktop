# MoE 1T Reproduction Study

## Why this project

The paper claims a sparsity-activated MoE at 1T params matches a dense 70B on zero-shot. If true, this changes our team's scaling roadmap. We want to reproduce the 8B result (what's public) as a sanity check before committing to the broader claim.

## Scope

- Reproduce Table 2 numbers on MMLU (57 subjects, 5-shot), ARC-Challenge, HellaSwag.
- One run per benchmark, reported with 95% CI.
- Compare our numbers to the paper's; flag gaps > 1%.

## Stakeholders

- **Me** — PI, running this.
- **Dr. Chen** — co-investigator; will co-sign the reproduction report.
- **Grad student (TBD)** — will help with the benchmark harness; spinning up next month.

## Key references

- **Paper** — arXiv:2024.12345 (methodology.md has our reading notes).
- **Released code** — github.com/acme/moe-release (we cloned, not forked — see `.git/config`).
- **MMLU harness** — use lm-evaluation-harness v0.4+.
