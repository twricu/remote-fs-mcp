import path from 'node:path';
import { CODE, fail } from '../common/errors.js';
import { LIMIT } from '../common/constants.js';

function validSegments(value) {
  if (!value.isWellFormed() || Buffer.byteLength(value) > LIMIT.PATH_BYTES || /[\\\0\uFFFD]/u.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '.' && part !== '..');
}
export function validateMount(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || value.endsWith('/') || value.includes('//') || !validSegments(value)) {
    fail(CODE.CONFIG_INVALID, 'mount.path');
  }
  return value;
}
export function resolvePath(mount, relative) {
  if (typeof relative !== 'string' || relative.length === 0) fail(CODE.PATH_OUT_OF_SCOPE);
  if (relative === '.') return mount;
  if (relative.startsWith('/') || relative.endsWith('/') || relative.includes('//') || !validSegments(relative)) fail(CODE.PATH_OUT_OF_SCOPE);
  const target = path.posix.join(mount, relative);
  const difference = path.posix.relative(mount, target);
  if (difference === '..' || difference.startsWith('../') || path.posix.isAbsolute(difference) || !validSegments(target)) fail(CODE.PATH_OUT_OF_SCOPE);
  return target;
}
export function safeName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && validSegments(name);
}
export async function inspectPath(io, absolute, expected, { allowMissing = false } = {}) {
  const parts = absolute.split('/').filter(Boolean);
  let current = '';
  let attrs = await io.call('lstat', '/');
  checkType(attrs, 'directory');
  for (let index = 0; index < parts.length; index++) {
    current += `/${parts[index]}`;
    try { attrs = await io.call('lstat', current); }
    catch (error) {
      if (allowMissing && index === parts.length - 1 && error.code === CODE.NOT_FOUND) return null;
      throw error;
    }
    if (attrs.isSymbolicLink()) fail(CODE.SYMLINK_DENIED);
    if (index < parts.length - 1) checkType(attrs, 'directory');
  }
  checkType(attrs, expected);
  return attrs;
}
export function checkType(attrs, expected) {
  if (attrs.isSymbolicLink()) fail(CODE.SYMLINK_DENIED);
  if (expected === 'directory' && !attrs.isDirectory()) fail(CODE.NOT_DIRECTORY);
  if (expected === 'file' && !attrs.isFile()) fail(CODE.NOT_REGULAR_FILE);
  if (!attrs.isDirectory() && !attrs.isFile()) fail(CODE.NOT_REGULAR_FILE);
}
