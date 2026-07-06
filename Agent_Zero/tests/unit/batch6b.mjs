import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgencyArgs, buildAttachmentArgs } from '../../brain/agency-cli.js';
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  handleTaskImageUpload,
  resolveTaskAttachmentReference,
  saveTaskImageUpload
} from '../../brain/attachments.js';
import { runTaskChatOnce } from '../../brain/task-chat.js';
import { migrateToV5, writeJsonFileAtomic } from '../../brain/tasks-v5.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-batch6b');

function resetTmp(name) {
  const dir = path.join(tmpRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir, data) {
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, `${JSON.stringify(migrateToV5(data), null, 2)}\n`, 'utf8');
  return file;
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('6B agency attachment args are repeatable and constrained to uploads', () => {
  const dir = resetTmp('agency-args');
  const uploadsDir = path.join(dir, 'uploads');
  const taskDir = path.join(uploadsDir, 'task-a');
  fs.mkdirSync(taskDir, { recursive: true });
  const inside = path.join(taskDir, 'screen.png');
  const outside = path.join(dir, 'outside.png');
  fs.writeFileSync(inside, Buffer.from('png'));
  fs.writeFileSync(outside, Buffer.from('png'));

  assert.deepEqual(buildAttachmentArgs({ attachments: [inside], uploadsDir }), ['--attachment', inside]);
  assert.throws(() => buildAttachmentArgs({ attachments: [outside], uploadsDir }), /outside uploads/);
  assert.throws(() => buildAttachmentArgs({ attachments: ['task-a/screen.png'], uploadsDir }), /absolute/);

  const args = buildAgencyArgs({
    bootstrap: 'prompt',
    brainWorkDir: path.join(dir, 'brain-work'),
    attachments: [inside],
    uploadsDir
  });
  assert.equal(args.includes('--no-ask-user'), true);
  assert.equal(args.includes('--attachment'), true);
  assert.equal(args[args.indexOf('--attachment') + 1], inside);
});

test('6B image upload handler enforces image type and 10 MB limit', async () => {
  const dir = resetTmp('upload-handler');
  const uploadsDir = path.join(dir, 'uploads');

  const okRes = fakeRes();
  await handleTaskImageUpload({
    params: { id: 'task-a' },
    headers: { 'content-type': 'image/png', 'x-file-name': 'screenshot.png' },
    body: Buffer.from([1, 2, 3])
  }, okRes, {
    uploadsDir,
    taskExists: id => id === 'task-a',
    now: new Date('2026-07-06T10:00:00.000Z')
  });
  assert.equal(okRes.statusCode, 201);
  assert.match(okRes.body.attachment.relativePath, /^task-a\//);
  assert.equal(fs.existsSync(path.join(uploadsDir, okRes.body.attachment.relativePath)), true);

  const typeRes = fakeRes();
  await handleTaskImageUpload({
    params: { id: 'task-a' },
    headers: { 'content-type': 'text/plain', 'x-file-name': 'note.txt' },
    body: Buffer.from('not image')
  }, typeRes, { uploadsDir, taskExists: () => true });
  assert.equal(typeRes.statusCode, 415);
  assert.match(typeRes.body.error, /Only image/);

  const sizeRes = fakeRes();
  await handleTaskImageUpload({
    params: { id: 'task-a' },
    headers: { 'content-type': 'image/png', 'x-file-name': 'big.png' },
    body: Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1)
  }, sizeRes, { uploadsDir, taskExists: () => true });
  assert.equal(sizeRes.statusCode, 413);
  assert.match(sizeRes.body.error, /10 MB/);
});

test('6B attachment references reject path traversal and cross-task paths', () => {
  const dir = resetTmp('traversal');
  const uploadsDir = path.join(dir, 'uploads');
  const saved = saveTaskImageUpload({
    taskId: 'task-a',
    originalName: 'screen.png',
    mimeType: 'image/png',
    buffer: Buffer.from('png'),
    uploadsDir,
    now: new Date('2026-07-06T10:00:00.000Z')
  });
  const relative = path.relative(uploadsDir, saved.absolutePath).replace(/\\/g, '/');

  const resolved = resolveTaskAttachmentReference({ taskId: 'task-a', attachment: relative, uploadsDir });
  assert.equal(resolved.absolutePath, saved.absolutePath);

  assert.throws(
    () => resolveTaskAttachmentReference({ taskId: 'task-a', attachment: '../outside.png', uploadsDir }),
    /Invalid attachment reference/
  );
  assert.throws(
    () => resolveTaskAttachmentReference({ taskId: 'task-b', attachment: relative, uploadsDir }),
    /outside this task upload folder/
  );
});

test('6B task chat passes image attachments to brain and stores history thumbnails', async () => {
  const dir = resetTmp('task-chat-attachments');
  const uploadsDir = path.join(dir, 'uploads');
  const saved = saveTaskImageUpload({
    taskId: 'task-a',
    originalName: 'mail-shot.png',
    mimeType: 'image/png',
    buffer: Buffer.from('png'),
    uploadsDir,
    now: new Date('2026-07-06T10:00:00.000Z')
  });
  const relativePath = path.relative(uploadsDir, saved.absolutePath).replace(/\\/g, '/');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'task-a',
      taskType: 'single',
      title: 'Task A',
      status: 'new',
      sourceRefs: [],
      history: []
    }]
  });
  const captured = {};

  await runTaskChatOnce({
    id: 'job-chat',
    taskId: 'task-a',
    input: {
      text: 'What does this screenshot change?',
      attachments: [{ relativePath, fileName: 'mail-shot.png', mimeType: 'image/png', uploadedAt: saved.uploadedAt }]
    },
    emit() {}
  }, {
    tasksFile,
    uploadsDir,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'chat-attachments',
    now: new Date('2026-07-06T10:05:00.000Z'),
    _runBrain: async (options) => {
      captured.attachments = options.attachments;
      captured.prompt = options.prompt;
      return { ok: true, assistantText: 'The screenshot does not require a task update.', counters: { workIqCalls: 0 } };
    },
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const savedTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const history = savedTasks.tasks[0].history.at(-1);

  assert.deepEqual(captured.attachments, [saved.absolutePath]);
  assert.match(captured.prompt, /Image attachments supplied with this user prompt/);
  assert.equal(history.attachments.length, 1);
  assert.equal(history.attachments[0].fileName, 'mail-shot.png');
  assert.match(history.attachments[0].url, /^\/api\/uploads\/task-a\//);
});

test('6B prompt files enforce English-only generated output', () => {
  const scanSkill = fs.readFileSync(path.join(repoRoot, 'docs', 'AGENCY_BRAIN_SCAN_SKILL.md'), 'utf8');
  const taskChat = fs.readFileSync(path.join(repoRoot, 'brain', 'task-chat.js'), 'utf8');
  const gateway = fs.readFileSync(path.join(repoRoot, 'brain', 'reality-gateway.js'), 'utf8');

  assert.match(scanSkill, /Always respond and write generated task content in English/);
  assert.match(taskChat, /Always respond and write generated task content in English/);
  assert.match(taskChat, /Answer the user in normal concise English text/);
  assert.match(gateway, /Always write gateway reasons and any generated review text in English/);
});

test('6B UI uses multiline chat controls and has no known German labels', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  assert.match(html, /<textarea class="task-chat-input"/);
  assert.match(html, /handleChatKeydown\(event/);
  assert.match(html, /handleChatPaste\(event/);
  assert.match(html, /attachment-preview/);

  for (const label of [
    'Stand heute',
    'Nutzer-Aktion nötig',
    'Warten auf',
    'Archivierte',
    'Quelle fehlt',
    'Quellen (',
    'Von dir erledigt',
    'Du musst aktiv werden'
  ]) {
    assert.equal(html.includes(label), false, `German UI label still present: ${label}`);
  }
});
