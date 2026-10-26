import path from 'node:path';
import { CODE, fail } from '../common/errors.js';
import { LIMIT } from '../common/constants.js';
import { inspectPath, safeName, checkType } from '../security/path-policy.js';
import { newMeta } from './read.js';

export function writeContent(args, security) {
  let bytes;
  if (args.encoding === 'base64') {
    bytes = Buffer.from(args.content, 'base64');
    if (bytes.toString('base64') !== args.content) fail(CODE.INVALID_ARGUMENT, 'content.encoding');
  } else {
    if (!args.content.isWellFormed()) fail(CODE.INVALID_ARGUMENT, 'content.encoding');
    bytes = Buffer.from(args.content, 'utf8');
  }
  if (bytes.length > security.maxWriteBytes) fail(CODE.INVALID_ARGUMENT, 'content.bytes');
  return bytes;
}

export async function writeBytes(io, absolute, bytes, mode = 'create', permissions = 0o644) {
  const attrs = await inspectPath(io, absolute, undefined, { allowMissing: true });
  if (attrs) {
    checkType(attrs, 'file');
    if (mode === 'create') fail(CODE.ALREADY_EXISTS);
  }
  let flags = 'wx';
  if (attrs) flags = 'r+';
  if (mode === 'append') {
    if (attrs) flags = 'a';
    else flags = 'ax';
  }
  const handle = await io.openWrite(absolute, flags, permissions);
  try {
    const current = await io.call('fstat', handle);
    checkType(current, 'file');
    if (!Number.isSafeInteger(current.size) || current.size < 0) fail(CODE.LIMIT_EXCEEDED);
    let offset = 0;
    if (mode === 'append') {
      if (!Number.isSafeInteger(current.size + bytes.length)) fail(CODE.LIMIT_EXCEEDED);
      offset = current.size;
    }
    else if (attrs) await io.mutate('fsetstat', handle, { size: 0 });
    for (let index = 0; index < bytes.length; index += LIMIT.CHUNK) {
      const length = Math.min(LIMIT.CHUNK, bytes.length - index);
      await io.mutate('write', handle, bytes, index, length, offset + index);
    }
  } finally { await io.closeHandle(handle); }
}

export async function writeFile(io, absolute, args, bytes) {
  await writeBytes(io, absolute, bytes, args.mode);
  return { data: { path: args.path, mode: args.mode, bytesWritten: bytes.length }, meta: { ...newMeta(), bytesWritten: bytes.length } };
}

export async function ensureDirectory(io, absolute, recursive, boundary, mode = 0o755) {
  const relative = path.posix.relative(boundary, absolute);
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) fail(CODE.PATH_OUT_OF_SCOPE);
  await inspectPath(io, boundary, 'directory');
  const targets = [];
  if (recursive && relative) {
    let current = boundary;
    for (const segment of relative.split('/')) { current = path.posix.join(current, segment); targets.push(current); }
  } else targets.push(absolute);
  let created = false;
  for (const target of targets) {
    const attrs = await inspectPath(io, target, undefined, { allowMissing: true });
    if (attrs) {
      checkType(attrs, 'directory');
      if (!recursive) fail(CODE.ALREADY_EXISTS);
    } else {
      await io.mutate('mkdir', target, { mode });
      await inspectPath(io, target, 'directory');
      created = true;
    }
  }
  return created;
}

export async function createDirectory(io, absolute, args, boundary) {
  const created = await ensureDirectory(io, absolute, args.recursive, boundary);
  return { data: { path: args.path, created }, meta: newMeta() };
}

export async function directoryEntries(io, absolute, budget, security) {
  const handle = await io.open(absolute, true);
  const result = [];
  try {
    while (true) {
      const batch = await io.call('readdir', handle, { full: true });
      if (batch === false) break;
      if (!Array.isArray(batch) || !batch.length) fail(CODE.REMOTE_ERROR);
      for (const entry of batch) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        if (++budget.entries > security.maxOperationEntries) fail(CODE.LIMIT_EXCEEDED);
        if (!safeName(entry.filename)) fail(CODE.PATH_OUT_OF_SCOPE);
        result.push(path.posix.join(absolute, entry.filename));
      }
    }
  } finally { await io.closeHandle(handle); }
  return result;
}

export async function collectTree(io, absolute, security) {
  const plan = [];
  const budget = { entries: 0 };
  const walk = async (target) => {
    const attrs = await inspectPath(io, target);
    if (attrs.isDirectory()) {
      for (const child of await directoryEntries(io, target, budget, security)) await walk(child);
    }
    plan.push({ absolute: target, directory: attrs.isDirectory() });
  };
  await walk(absolute);
  return plan;
}

export async function deletePath(io, absolute, args, security) {
  const attrs = await inspectPath(io, absolute);
  let plan = [{ absolute, directory: attrs.isDirectory() }];
  if (attrs.isDirectory()) {
    if (args.recursive) plan = await collectTree(io, absolute, security);
    else if ((await directoryEntries(io, absolute, { entries: 0 }, security)).length) fail(CODE.NOT_EMPTY);
  }
  let filesDeleted = 0;
  let directoriesDeleted = 0;
  for (const item of plan) {
    await inspectPath(io, item.absolute, item.directory ? 'directory' : 'file');
    if (item.directory) { await io.mutate('rmdir', item.absolute); directoriesDeleted++; }
    else { await io.mutate('unlink', item.absolute); filesDeleted++; }
  }
  return { data: { path: args.path, filesDeleted, directoriesDeleted }, meta: newMeta() };
}

export async function movePath(io, absolute, destination, args, security) {
  if (absolute === destination || destination.startsWith(absolute + '/')) fail(CODE.INVALID_ARGUMENT, 'destinationPath');
  const plan = await collectTree(io, absolute, security);
  const attrs = await inspectPath(io, destination, undefined, { allowMissing: true });
  if (attrs) {
    if (!args.overwrite) fail(CODE.ALREADY_EXISTS);
    const source = plan[plan.length - 1];
    checkType(attrs, source.directory ? 'directory' : 'file');
    if (attrs.isDirectory() && (await directoryEntries(io, destination, { entries: 0 }, security)).length) fail(CODE.NOT_EMPTY);
  }
  await inspectPath(io, absolute);
  if (attrs) {
    if (typeof io.channel.ext_openssh_rename !== 'function') fail(CODE.UNSUPPORTED_OPERATION);
    try { await io.mutate('ext_openssh_rename', absolute, destination); }
    catch (error) {
      if (error.message === 'Server does not support this extended request') fail(CODE.UNSUPPORTED_OPERATION);
      throw error;
    }
  } else await io.mutate('rename', absolute, destination);
  return { data: { path: args.path, destinationMountId: args.destinationMountId ?? args.mountId, destinationPath: args.destinationPath }, meta: newMeta() };
}
