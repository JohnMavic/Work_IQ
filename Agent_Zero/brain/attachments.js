import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_UPLOADS_DIR = path.join(REPO_ROOT, 'uploads');
export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const IMAGE_EXTENSION_BY_MIME = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
  ['image/svg+xml', '.svg'],
  ['image/tiff', '.tiff']
]);

const MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff']
]);

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.expose = statusCode < 500;
  return err;
}

function normalizeMimeType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

export function isAllowedImageMimeType(value) {
  return /^image\/[-+.\w]+$/i.test(normalizeMimeType(value));
}

export function isPathInside(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function safeTaskUploadSegment(taskId) {
  const raw = String(taskId || '').trim();
  if (!raw) throw httpError(400, 'Task id is required');
  if (raw.includes('..') || /[\\/]/.test(raw)) {
    throw httpError(400, 'Invalid task id');
  }
  const segment = raw.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120);
  if (!segment || segment === '.' || segment === '..') {
    throw httpError(400, 'Invalid task id');
  }
  return segment;
}

function safeOriginalName(value) {
  const raw = String(value || 'image').trim();
  const base = path.basename(raw).replace(/[^a-zA-Z0-9_. -]/g, '-').slice(0, 120);
  return base || 'image';
}

function extensionForUpload(mimeType, originalName) {
  const mime = normalizeMimeType(mimeType);
  const fromMime = IMAGE_EXTENSION_BY_MIME.get(mime);
  if (fromMime) return fromMime;
  const ext = path.extname(safeOriginalName(originalName)).toLowerCase();
  if (MIME_BY_EXTENSION.has(ext)) return ext;
  return '.img';
}

function decodeHeaderFilename(value) {
  if (!value) return 'image';
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

function buildStoredFilename({ originalName, mimeType, now = new Date(), randomBytes = crypto.randomBytes }) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(6).toString('hex');
  const stem = safeOriginalName(originalName).replace(/\.[^.]*$/, '').replace(/\s+/g, '-').slice(0, 60) || 'image';
  return `${stamp}-${suffix}-${stem}${extensionForUpload(mimeType, originalName)}`;
}

export function taskUploadDir(taskId, uploadsDir = DEFAULT_UPLOADS_DIR) {
  return path.join(path.resolve(uploadsDir), safeTaskUploadSegment(taskId));
}

export function publicAttachmentFromSaved(saved, uploadsDir = DEFAULT_UPLOADS_DIR) {
  const relativePath = path.relative(path.resolve(uploadsDir), saved.absolutePath).replace(/\\/g, '/');
  return {
    id: relativePath,
    relativePath,
    url: `/api/uploads/${encodeURIComponent(saved.taskSegment)}/${encodeURIComponent(saved.filename)}`,
    fileName: saved.originalName,
    storedName: saved.filename,
    mimeType: saved.mimeType,
    size: saved.size,
    uploadedAt: saved.uploadedAt
  };
}

export function saveTaskImageUpload({
  taskId,
  originalName = 'image',
  mimeType,
  buffer,
  uploadsDir = DEFAULT_UPLOADS_DIR,
  now = new Date(),
  randomBytes = crypto.randomBytes
} = {}) {
  const normalizedMime = normalizeMimeType(mimeType);
  if (!isAllowedImageMimeType(normalizedMime)) {
    throw httpError(415, 'Only image attachments are allowed');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw httpError(400, 'Attachment body is required');
  }
  if (buffer.length > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw httpError(413, 'Image attachment exceeds the 10 MB limit');
  }

  const root = path.resolve(uploadsDir);
  const taskSegment = safeTaskUploadSegment(taskId);
  const dir = path.join(root, taskSegment);
  const filename = buildStoredFilename({ originalName, mimeType: normalizedMime, now, randomBytes });
  const absolutePath = path.resolve(dir, filename);
  if (!isPathInside(root, absolutePath) || !isPathInside(dir, absolutePath)) {
    throw httpError(400, 'Invalid attachment path');
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(absolutePath, buffer, { flag: 'wx' });

  return {
    taskId,
    taskSegment,
    filename,
    originalName: safeOriginalName(originalName),
    mimeType: normalizedMime,
    size: buffer.length,
    uploadedAt: now.toISOString(),
    absolutePath
  };
}

export function resolveTaskAttachmentReference({ taskId, attachment, uploadsDir = DEFAULT_UPLOADS_DIR } = {}) {
  const root = path.resolve(uploadsDir);
  const dir = taskUploadDir(taskId, root);
  const raw = typeof attachment === 'string'
    ? attachment
    : attachment?.relativePath || attachment?.id || attachment?.path || '';
  if (!raw || typeof raw !== 'string') {
    throw httpError(400, 'Attachment reference is required');
  }
  if (path.isAbsolute(raw)) {
    throw httpError(400, 'Attachment references must be relative upload paths');
  }
  const normalizedRaw = raw.replace(/\\/g, '/');
  if (normalizedRaw.includes('\0') || normalizedRaw.split('/').some(part => part === '..')) {
    throw httpError(400, 'Invalid attachment reference');
  }

  const absolutePath = path.resolve(root, normalizedRaw);
  if (!isPathInside(root, absolutePath) || !isPathInside(dir, absolutePath)) {
    throw httpError(400, 'Attachment is outside this task upload folder');
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw httpError(404, 'Attachment not found');
  }

  const filename = path.basename(absolutePath);
  const ext = path.extname(filename).toLowerCase();
  const mimeType = normalizeMimeType(attachment?.mimeType) || MIME_BY_EXTENSION.get(ext) || 'image/*';
  if (!isAllowedImageMimeType(mimeType)) {
    throw httpError(415, 'Only image attachments are allowed');
  }
  const stat = fs.statSync(absolutePath);
  if (stat.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw httpError(413, 'Image attachment exceeds the 10 MB limit');
  }

  const relativePath = path.relative(root, absolutePath).replace(/\\/g, '/');
  const taskSegment = safeTaskUploadSegment(taskId);
  return {
    id: relativePath,
    relativePath,
    absolutePath,
    url: `/api/uploads/${encodeURIComponent(taskSegment)}/${encodeURIComponent(filename)}`,
    fileName: attachment?.fileName || attachment?.originalName || filename,
    storedName: filename,
    mimeType,
    size: stat.size,
    uploadedAt: attachment?.uploadedAt || stat.mtime.toISOString()
  };
}

export function resolveTaskAttachmentReferences({ taskId, attachments = [], uploadsDir = DEFAULT_UPLOADS_DIR } = {}) {
  if (!Array.isArray(attachments)) {
    throw httpError(400, 'attachments must be an array');
  }
  return attachments.map(attachment => resolveTaskAttachmentReference({ taskId, attachment, uploadsDir }));
}

export function attachmentContextForPrompt(attachments = []) {
  return attachments.map((attachment, index) => {
    const sourceRefId = `src-manual-${index + 1}-${crypto
      .createHash('sha1')
      .update(attachment.relativePath || attachment.fileName || String(index))
      .digest('hex')
      .slice(0, 10)}`;
    return {
      sourceRefId,
      fileName: attachment.fileName || attachment.storedName || 'image',
      mimeType: attachment.mimeType || 'image/*',
      size: attachment.size || null,
      uploadedAt: attachment.uploadedAt || null
    };
  });
}

export function historyAttachmentsFromResolved(attachments = []) {
  return attachments.map(attachment => ({
    id: attachment.id,
    relativePath: attachment.relativePath,
    url: attachment.url,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    uploadedAt: attachment.uploadedAt
  }));
}

export function getUploadedAttachmentFile({ taskId, filename, uploadsDir = DEFAULT_UPLOADS_DIR } = {}) {
  const dir = taskUploadDir(taskId, uploadsDir);
  const rawName = String(filename || '');
  if (!rawName || rawName.includes('..') || /[\\/]/.test(rawName)) {
    throw httpError(400, 'Invalid attachment filename');
  }
  const absolutePath = path.resolve(dir, rawName);
  if (!isPathInside(dir, absolutePath)) {
    throw httpError(400, 'Invalid attachment path');
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw httpError(404, 'Attachment not found');
  }
  const mimeType = MIME_BY_EXTENSION.get(path.extname(absolutePath).toLowerCase()) || 'application/octet-stream';
  return { absolutePath, mimeType };
}

export async function handleTaskImageUpload(req, res, {
  uploadsDir = DEFAULT_UPLOADS_DIR,
  taskExists = () => true,
  now = new Date()
} = {}) {
  try {
    const taskId = req.params?.id;
    if (!taskExists(taskId)) {
      return res.status(404).json({ error: 'Task not found' });
    }
    const mimeType = req.headers?.['content-type'] || req.get?.('content-type') || '';
    const originalName = decodeHeaderFilename(req.headers?.['x-file-name'] || req.get?.('x-file-name'));
    const saved = saveTaskImageUpload({
      taskId,
      originalName,
      mimeType,
      buffer: req.body,
      uploadsDir,
      now
    });
    return res.status(201).json({ attachment: publicAttachmentFromSaved(saved, uploadsDir) });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.expose ? err.message : 'Failed to upload attachment' });
  }
}

export function handleTaskImageUploadError(err, _req, res, next) {
  if (!err) return next();
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ error: 'Image attachment exceeds the 10 MB limit' });
  }
  return next(err);
}
