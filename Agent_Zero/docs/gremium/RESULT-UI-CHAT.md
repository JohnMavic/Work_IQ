UICHAT: OK

## Summary
- Moved the task chat into a docked bottom area inside the task detail panel.
- Kept the existing task chat textarea handlers for Enter send, Shift+Enter newline, image paste, drag/drop, thumbnails, upload, and job submission.
- Kept PM sections, Fact Sheet, task details, and history above the dock in a separate scrollable detail area.
- Applied the same detail renderer for project and single tasks.

## Verification
- `npm test` passed: 113/113.
- `tasks.json` was not modified. SHA-256 before and after: `B552203F2CB11CE6BDA6D658DD024213933B3C3FA048FF8F971457208F61A5C6`.
- No STOP/START scripts were run and no server restart was performed.

## Manual UI Checklist
- Open a single task and confirm the composer is always visible at the bottom of the detail panel while task content scrolls above it.
- Open a project task and confirm PM sections, line items, Fact Sheet, and history remain reachable above the dock.
- Confirm the conversation history appears directly above the composer, with the latest exchange visible and older exchanges reachable by scrolling upward.
- Confirm the placeholder reads: `Ask the agent about this task… (Shift+Enter = new line, paste images/screenshots)`.
- Confirm Shift+Enter inserts a newline, Enter sends, and pasted screenshots appear as thumbnails above the input.
- Start a chat job and confirm the composer remains visible, disables input/actions, and shows a spinner until the job finishes.
