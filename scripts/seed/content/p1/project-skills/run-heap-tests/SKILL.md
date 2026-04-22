---
name: run-heap-tests
description: Run the Rust heap + priority queue test suite and report any failures in plain English, pointing at the specific test name and assertion.
version: 0.1.0
author: Omni Seed
---

# Run Heap Tests

Run the test suite for this CS 2341 assignment and summarize results.

## Commands

```
cargo test --lib -- --nocapture
```

If you want only the heap tests:

```
cargo test --lib heap
```

## Reporting rules

- If all tests pass, say so in one sentence (count + elapsed).
- If any fail, list each failure as `<test_name>: <assertion>` — don't dump the whole stderr.
- If the build itself fails, report the first compile error with its file:line; ignore the rest until the first one is fixed.
- If `cargo` is not on the PATH, install Rust (`rustup`) and retry.

## Scope

This skill is specific to `cs-homework-dsa`. It knows:
- The project uses `cargo test --lib` (not `cargo test` — the `bench` binary is excluded from the test target).
- Heap tests live in `src/heap.rs`; priority queue tests will live in `src/priority_queue.rs` once implemented.
