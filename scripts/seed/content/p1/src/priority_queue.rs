//! TODO(ticket): priority queue layered on MinHeap.
//!
//! Desired API:
//!     let mut pq = PriorityQueue::new();
//!     pq.enqueue("task", 3);
//!     pq.enqueue("urgent", 1);
//!     assert_eq!(pq.dequeue(), Some("urgent"));
