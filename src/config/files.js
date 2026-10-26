import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { CODE, fail, FsError } from '../common/errors.js';

export function localPath(value, base, home) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail(CODE.CONFIG_INVALID, 'localFile');
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return path.resolve(base, value);
}
export function localText(bytes, label) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_error) { fail(CODE.CONFIG_INVALID, label); }
}
export async function readBounded(file, maximum, label) {
  let handle;
  try {
    const before = await stat(file);
    if (!before.isFile() || before.size > maximum) fail(CODE.CONFIG_INVALID, label);
    handle = await open(file, 'r');
    const attrs = await handle.stat();
    if (!attrs.isFile() || attrs.size > maximum) fail(CODE.CONFIG_INVALID, label);
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximum) fail(CODE.CONFIG_INVALID, label);
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof FsError) throw error;
    fail(CODE.CONFIG_INVALID, label);
  } finally {
    if (handle) await handle.close();
  }
}
