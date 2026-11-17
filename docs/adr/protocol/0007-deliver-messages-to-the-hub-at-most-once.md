# 0007. Deliver messages to the hub at most once

## Status

Accepted · 2026-10-21

## Context

The connector runs inside the host app, so its memory, CPU and I/O must stay small and bounded. Snapshots are
diagnostic data: one more hit of the same breakpoint usually replaces a lost one. Breakpoint state is owned by the
hub, which can send it again at any time. Connections to the hub drop, and the host app restarts.

## Decision

We deliver SDK messages at most once and keep them only in memory: messages already handed to the socket when it
drops are lost and not resent; queued ones wait in bounded queues for the next `welcome`, and the oldest are
dropped when a queue is full. Right after every `welcome`, the hub sends the full breakpoint list.

## Alternatives

- **Acknowledged delivery while the process lives** — message ids, acks, resends and duplicate handling on the
  hub, and unacked messages held in the host app's memory, for data that is usually replaced by the next hit.
- **Durable delivery through a disk spool** — disk I/O and files inside the host app, and messages that outlive
  the code version that produced them.

## Consequences

- The protocol needs no message ids or acks, and the hub no deduplication.
- A disconnect can lose snapshots; users see a gap, not wrong data. Lost breakpoint statuses are sent again after
  the reconnect, because the SDK answers the list after `welcome` with the status of every listed breakpoint.
- Breakpoints stay set while the hub is unreachable; the list after the next `welcome` replaces them, so no change
  has to survive a disconnect.
