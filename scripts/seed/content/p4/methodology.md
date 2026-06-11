# Methodology Notes

Reading notes + interpretations. Chronological.

## Paper claims (§ 3.2, Table 2)

- 8B MoE matches 8B dense on MMLU (within 0.3%).
- 1T MoE matches 70B dense on MMLU (within 0.8%).
- Activation: top-2 experts per token, load-balancing auxiliary loss.

## What's actually reproducible

- **Yes**: 8B baseline — weights released via HuggingFace, full config in appendix B.
- **Partial**: Their eval code is in the supplemental, but uses an old lm-eval-harness fork.
- **No**: 1T run — weights not released; they say "available on request" but the request link is dead.

## Decisions for our reproduction

- **Harness**: lm-evaluation-harness mainline v0.4.3, NOT the paper's fork. Document any deltas.
- **Precision**: bf16 inference (matches the paper).
- **Batch size**: 8. The paper uses 16; we have 8×A100s.
- **Seed**: 42. The paper doesn't disclose theirs.

## Open questions

- Why does the paper's Table 2 report no variance? Single run, or mean over N?
- How is "zero-shot" defined — genuine 0-shot, or 5-shot with identity prompt?
