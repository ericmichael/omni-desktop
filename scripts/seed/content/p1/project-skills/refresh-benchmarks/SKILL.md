---
name: refresh-benchmarks
description: Rebuild the bench binary, regenerate target/bench.json, and refresh the marimo notebook so the charts reflect the latest numbers.
version: 0.1.0
author: Omni Seed
---

# Refresh Benchmarks

Re-run the heap benchmarks and update the notebook.

## Process

1. `cargo run --release --bin bench > target/bench.json`
2. Open `benchmarks.py` in marimo (the agent may need to trigger a reload — the notebook reads from `target/bench.json` on cell evaluation).
3. Verify the new row count matches expectations (should be > the previous run, not zero).

## Scope

Specific to `cs-homework-dsa`. Knows:
- Benchmark binary is `bench`, defined in `Cargo.toml` at `src/bench.rs`.
- Output format is a JSON array of `{ impl, n, elapsed_ns }` rows.
- Only run with `--release` — debug builds give misleading numbers.

## When to stop

- If `target/bench.json` has identical bytes to the last run, something went wrong — flag it.
- If the bench binary panics, capture stderr and drop it into a new Page titled "bench failure <date>".
