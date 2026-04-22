# Big-O Cheat Sheet

Quick reference for the common data structures in this course.

## Arrays / Vec

| Op        | Avg      | Worst    |
|-----------|----------|----------|
| Access    | O(1)     | O(1)     |
| Search    | O(n)     | O(n)     |
| Push      | O(1) amortized | O(n) |
| Insert@i  | O(n)     | O(n)     |

## Binary Heap

| Op        | Avg      | Worst    |
|-----------|----------|----------|
| Push      | O(log n) | O(log n) |
| Pop       | O(log n) | O(log n) |
| Peek      | O(1)     | O(1)     |
| Heapify   | O(n)     | O(n)     |

## Hash Map

| Op        | Avg      | Worst    |
|-----------|----------|----------|
| Get       | O(1)     | O(n)     |
| Insert    | O(1)     | O(n)     |
| Delete    | O(1)     | O(n)     |

Worst case is when everything hashes to the same bucket. Rust's default hasher (`SipHash-1-3`) is resistant to HashDoS.

## Binary Search Tree (unbalanced)

Don't use an unbalanced BST in practice — worst case degenerates to O(n). Use a `BTreeMap` instead.
