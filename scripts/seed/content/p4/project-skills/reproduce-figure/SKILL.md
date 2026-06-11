---
name: reproduce-figure
description: Run the Table 2 reproduction end-to-end (python scripts/reproduce_table_2.py), then refresh the marimo notebook so the chart reflects the new run.
version: 0.1.0
author: Omni Seed
---

# Reproduce Figure

Re-run the paper reproduction harness and update the notebook.

## Process

1. Ensure the venv is active (`.venv` exists — if not, `python -m venv .venv && pip install -r requirements.txt`).
2. Run `python scripts/reproduce_table_2.py --model 8b --output results/`.
3. Confirm a new `results/table_2_<timestamp>.json` file appeared.
4. Open `figure-3-reproduction.py` in marimo and re-evaluate — the new run should show up in the "Loaded N run(s)" cell.

## Scope

Specific to `paper-reproducibility`. Knows:
- Benchmarks are `mmlu`, `arc_challenge`, `hellaswag`.
- Batch size 8, seed 42, bf16 — these are our repro parameters, not the paper's.
- Deltas > 1% from the paper's reported numbers are worth flagging in `methodology.md`.

## When to stop

- If the harness fails to load the model (e.g., HuggingFace rate-limit), do NOT silently retry — report the error and let the user decide.
- If `lm-eval` is outdated (< 0.4.3), stop and recommend upgrading.
