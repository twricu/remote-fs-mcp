import { CODE, fail } from '../common/errors.js';
import { LIMIT, REASON } from '../common/constants.js';
import { checkType } from '../security/path-policy.js';
import { decodeText } from './text.js';

export function metadata(attrs, relative) {
  let type = 'file';
  if (attrs.isDirectory()) type = 'directory';
  let size = null;
  if (Number.isSafeInteger(attrs.size) && attrs.size >= 0) size = attrs.size;
  let mtime = null;
  if (Number.isFinite(attrs.mtime) && Math.abs(attrs.mtime * 1000) <= 8640000000000000) mtime = new Date(attrs.mtime * 1000).toISOString();
  return { path: relative, type, size, mtime };
}
export function newMeta() { return { truncated: false, reasons: [], bytesRead: 0, skipped: {} }; }
export function mark(meta, reason) { meta.truncated = true; if (!meta.reasons.includes(reason)) meta.reasons.push(reason); }
export function skip(meta, reason) { meta.skipped[reason] = (meta.skipped[reason] ?? 0) + 1; }
export async function openFile(io, absolute) {
  const handle = await io.open(absolute);
  const attrs = await io.call('fstat', handle);
  checkType(attrs, 'file');
  if (!Number.isSafeInteger(attrs.size) || attrs.size < 0) fail(CODE.LIMIT_EXCEEDED);
  return { handle, size: attrs.size };
}
export async function readRange(io, handle, start, length) {
  const parts = [];
  let count = 0;
  while (count < length) {
    io.operation.check();
    const buffer = Buffer.alloc(Math.min(LIMIT.CHUNK, length - count));
    const [bytesRead] = await io.call('read', handle, buffer, 0, buffer.length, start + count);
    if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length) fail(CODE.REMOTE_ERROR);
    if (!bytesRead) break;
    parts.push(buffer.subarray(0, bytesRead));
    count += bytesRead;
  }
  return Buffer.concat(parts, count);
}
export async function readFile(io, absolute, args) {
  const { handle, size } = await openFile(io, absolute);
  const meta = newMeta();
  const length = Math.max(0, Math.min(args.maxBytes, size - args.offset));
  const bytes = await readRange(io, handle, args.offset, length);
  meta.bytesRead = bytes.length;
  const reachedEnd = args.offset + bytes.length >= size;
  const content = decodeText(bytes, { partialEnd: !reachedEnd, offset: args.offset });
  const bytesReturned = Buffer.byteLength(content);
  if (bytes.length > 0 && bytesReturned === 0) fail(CODE.INVALID_ARGUMENT);
  const nextOffset = args.offset + bytesReturned;
  const eof = nextOffset >= size;
  if (!eof) mark(meta, REASON.READ);
  if (bytes.length < length) mark(meta, REASON.CHANGED);
  return { data: { path: args.path, content, encoding: 'utf-8', bytesRead: bytes.length, bytesReturned, nextOffset, eof }, meta };
}
export async function tailFile(io, absolute, args, security) {
  const { handle, size } = await openFile(io, absolute);
  const meta = newMeta();
  const parts = [];
  let position = size;
  let newlines = 0;
  while (position > 0 && meta.bytesRead < security.maxReadBytes && newlines <= args.lines) {
    const length = Math.min(LIMIT.CHUNK, security.maxReadBytes - meta.bytesRead, position);
    position -= length;
    const bytes = await readRange(io, handle, position, length);
    meta.bytesRead += bytes.length;
    if (bytes.length < length) { mark(meta, REASON.CHANGED); break; }
    for (const byte of bytes) { if (byte === 10) newlines++; }
    parts.unshift(bytes);
  }
  const tail = tailText(Buffer.concat(parts), position > 0, args.lines, meta);
  return { data: { path: args.path, ...tail, bytesRead: meta.bytesRead }, meta };
}
export function tailText(input, partial, requestedLines, meta) {
  let bytes = input;
  if (partial) {
    const newline = bytes.indexOf(10);
    if (newline === -1) bytes = Buffer.alloc(0);
    else bytes = bytes.subarray(newline + 1);
  }
  let text = decodeText(bytes);
  const trailing = text.endsWith('\n');
  if (trailing) text = text.slice(0, -1);
  let lines = [];
  if (text.length || trailing) lines = text.split('\n').map((line) => line.replace(/\r$/u, ''));
  if (partial && lines.length < requestedLines) mark(meta, REASON.READ);
  lines = lines.slice(-requestedLines);
  let content = lines.join('\n');
  if (trailing && lines.length) content += '\n';
  return { content, linesReturned: lines.length };
}
