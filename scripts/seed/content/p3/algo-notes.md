# CS 2341 — Algorithms Notes

## Heaps (lecture 7)

- Min-heap property: every parent ≤ its children.
- Array-backed: parent of index `i` is `(i-1)/2`; children are `2i+1` and `2i+2`.
- Insert: append, sift up. O(log n).
- Extract-min: swap root with last, pop, sift down. O(log n).
- Heapify (build heap from array): O(n), NOT O(n log n) — tight analysis uses the fact that most elements are near the leaves.

## Quicksort (lecture 8)

- Partition around a pivot; recurse on both halves.
- Worst case O(n²) when pivot is always min/max (sorted input with naive pivot choice).
- Randomized pivot → expected O(n log n).
- In-place but NOT stable.

## Open questions

- Is there a reason CS 2341 doesn't cover introsort? (Hybrid of quicksort + heapsort that avoids O(n²).)
