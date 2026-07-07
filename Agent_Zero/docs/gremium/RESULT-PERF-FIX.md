PERF: OK

# Performance Fix Interactivity

- Added priority Brain scheduling with two global slots and a maximum of one background slot.
- Routed task chat as interactive, scans/sweeps/migrations as background by default, and kept gateway effort on the xhigh brain default.
- Skipped the Reality Gateway for marker-free task-chat answers.
- Added queued/phase/elapsed UI feedback through existing SSE job events.
- Verified with `npm test` (121/121).
