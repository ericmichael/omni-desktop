# CS 3352 — Operating Systems Notes

## Lecture 1 — What is an OS?

- OS is a resource manager. Three resources: CPU, memory, I/O.
- Virtualization = illusion of many CPUs / unlimited memory.
- Concurrency = managing multiple in-flight things.
- Persistence = data survives power loss.

## Lecture 2 — Processes

- Process = running program. State = code + data + stack + heap + registers + open files.
- `fork()` copies the current process; returns 0 to child, child's PID to parent.
- `exec()` replaces the current process image.
- Classic Unix pattern: `fork()` then child calls `exec()` → parent `wait()`s.

## Open questions

- What happens to file descriptors across `fork()` vs `exec()`? — ask in office hours.
- Why does `fork()` return twice? (Once in parent, once in child — each sees their own return value.)
