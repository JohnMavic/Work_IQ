BATCH6B: OK

Implemented:
- Task chat now uses an auto-growing textarea: Enter sends, Shift+Enter inserts a newline.
- Image paste and drag/drop are supported in the task detail chat input with thumbnail preview and remove buttons before send.
- Images upload through `POST /api/tasks/:id/attachments`, are limited to `image/*` and 10 MB, stored under `uploads/<taskId>/`, ignored by git, and served through guarded `/api/uploads/...` URLs.
- Agency Brain task chat receives validated upload paths as repeatable `--attachment <absolute path>` args, constrained to the uploads tree.
- Task-chat state and prompt describe attached images as part of the user prompt; image-derived marker evidence must use `type:"manual"` sourceRefs with English evidence text.
- Chat history entries store attachment metadata and render thumbnails in conversations.
- English-only generation rules were added to scan, task-chat, gateway, and legacy fallback prompts; UI labels and user-action badges were unified in English.
- `scripts/translate-generated-english.mjs --apply` scanned active generated task fields. It made no write because no known German app-generated phrases were present; residual hits were source-derived quoted/original text and left unchanged.

Tests:
- `npm test` passed: 104/104.
- Added Batch-6B unit coverage for attachment argv validation, upload type/size guards, traversal/cross-task rejection, task-chat attachment forwarding/history thumbnails, English prompt rules, and static UI label checks.

Manual UI checklist to execute in the running app:
- Open a task detail panel, type multiple lines with Shift+Enter, then press Enter and confirm the existing task-chat job flow starts.
- Paste one or more screenshots into the chat input and confirm thumbnails appear.
- Remove one thumbnail with its X button and confirm it is not sent.
- Drag/drop an image into the input and confirm it previews.
- Send a message with an image and confirm the conversation history shows the image thumbnail after the job completes.
- Try a non-image file and an image over 10 MB; confirm the user-facing error is English and the file is rejected.
