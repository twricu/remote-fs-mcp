import path from 'node:path';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import yauzl from 'yauzl';
import CRC32 from 'crc-32';
import { CODE, FsError, fail } from '../common/errors.js';
import { REASON, LIMIT } from '../common/constants.js';
import { resolvePath, inspectPath, checkType } from '../security/path-policy.js';
import { openFile, readRange, newMeta, mark, tailText } from './read.js';
import { decodeText } from './text.js';
import { ensureDirectory, writeBytes } from './mutate.js';

export function archiveFormat(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.gz')) return 'gzip';
  return null;
}

function entryName(value, directory) {
  if (typeof value !== 'string') fail(CODE.INVALID_ARCHIVE);
  let name = value;
  while (name.startsWith('./')) name = name.slice(2);
  if (directory) name = name.replace(/\/+$/u, '');
  if (directory && (!name || name === '.')) return null;
  if (/^[A-Za-z]:/u.test(name)) fail(CODE.INVALID_ARCHIVE);
  try { resolvePath('/archive', name); }
  catch (_error) { fail(CODE.INVALID_ARCHIVE); }
  return name;
}

async function collect(stream, maximum, operation, limitDetail) {
  const parts = [];
  let size = 0;
  const abort = () => stream.destroy(operation.signal.reason);
  stream.on('error', () => {});
  operation.signal.addEventListener('abort', abort, { once: true });
  try {
    operation.check();
    for await (const bytes of stream) {
      operation.check();
      size += bytes.length;
      if (size > maximum) fail(CODE.LIMIT_EXCEEDED, limitDetail);
      parts.push(bytes);
    }
    if (parts.length === 1) return parts[0];
    return Buffer.concat(parts, size);
  } finally {
    operation.signal.removeEventListener('abort', abort);
    stream.destroy();
  }
}

export async function loadArchive(io, absolute, name, security, { content = false, selection, processingBudget = Number.MAX_SAFE_INTEGER } = {}) {
  const format = archiveFormat(name);
  if (!format) fail(CODE.UNSUPPORTED_ARCHIVE);
  const { handle, size } = await openFile(io, absolute);
  let raw;
  try {
    if (size > security.maxArchiveBytes) fail(CODE.LIMIT_EXCEEDED, 'archive.bytes');
    if (size > processingBudget) fail(CODE.LIMIT_EXCEEDED, 'scan.bytes');
    raw = await readRange(io, handle, 0, size);
    if (raw.length !== size) fail(CODE.INVALID_ARCHIVE, 'source.changed');
  } finally { await io.closeHandle(handle); }
  const entries = [];
  const maxExpanded = Math.min(security.maxExtractBytes, processingBudget - raw.length);
  let expansionLimit = 'archive.expanded';
  if (processingBudget - raw.length < security.maxExtractBytes) expansionLimit = 'scan.bytes';
  const names = new Map();
  const parents = new Set();
  let expandedBytes = 0;
  let selectedFirst = false;
  const wanted = (entry) => {
    if (!content || !entry || entry.type !== 'file') return false;
    if (selection === undefined) return true;
    if (selection !== null) return selection === entry.name;
    if (selectedFirst) return false;
    selectedFirst = true;
    return true;
  };
  const add = (value, directory, entrySize, mode) => {
    io.operation.check();
    if (!Number.isSafeInteger(entrySize) || entrySize < 0) fail(CODE.INVALID_ARCHIVE);
    const name = entryName(value, directory);
    if (name === null) return null;
    if (entries.length >= security.maxOperationEntries) fail(CODE.LIMIT_EXCEEDED, 'archive.entries');
    if (names.has(name)) {
      if (directory && names.get(name) === 'directory') return null;
      fail(CODE.INVALID_ARCHIVE);
    }
    for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) {
      if (names.get(parent) === 'file') fail(CODE.INVALID_ARCHIVE);
      parents.add(parent);
    }
    if (!directory && parents.has(name)) fail(CODE.INVALID_ARCHIVE);
    const entry = { name, type: directory ? 'directory' : 'file', size: entrySize, mode: mode & 0o777 };
    entries.push(entry);
    names.set(name, entry.type);
    return entry;
  };
  try {
    if (format === 'zip') {
      const zip = await io.operation.wait(yauzl.fromBufferPromise(raw, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }));
      let zipError;
      const onError = (error) => { zipError = error; };
      zip.on('error', onError);
      const next = () => io.operation.wait(new Promise((resolve, reject) => {
        if (zipError) { reject(zipError); return; }
        const cleanup = () => { zip.removeListener('entry', entry); zip.removeListener('end', end); zip.removeListener('error', error); };
        const entry = (value) => { cleanup(); resolve(value); };
        const end = () => { cleanup(); resolve(null); };
        const error = (value) => { cleanup(); reject(value); };
        zip.once('entry', entry); zip.once('end', end); zip.once('error', error);
        zip.readEntry();
      }));
      try {
        const selected = [];
        let record;
        while ((record = await next()) !== null) {
          const mode = record.externalFileAttributes >>> 16;
          const type = mode & 0o170000;
          const directory = record.fileName.endsWith('/') || type === 0o040000;
          if (type && type !== 0o100000 && type !== 0o040000) fail(CODE.INVALID_ARCHIVE);
          if (record.generalPurposeBitFlag & 1) fail(CODE.UNSUPPORTED_ARCHIVE);
          if (record.compressionMethod !== 0 && record.compressionMethod !== 8) fail(CODE.UNSUPPORTED_ARCHIVE);
          const entry = add(record.fileName, directory, record.uncompressedSize, mode || 0o644);
          if (wanted(entry)) selected.push({ entry, record });
        }
        for (const { entry, record } of selected) {
          if (expandedBytes + entry.size > maxExpanded) fail(CODE.LIMIT_EXCEEDED, expansionLimit);
          const stream = await io.operation.wait(zip.openReadStreamPromise(record));
          entry.content = await collect(stream, maxExpanded - expandedBytes, io.operation, expansionLimit);
          expandedBytes += entry.content.length;
          if (entry.content.length !== entry.size || (CRC32.buf(entry.content) >>> 0) !== record.crc32) fail(CODE.INVALID_ARCHIVE);
        }
      } finally { zip.close(); zip.removeListener('error', onError); zip.on('error', () => {}); }
    } else {
      let bytes = raw;
      if (format === 'tar.gz' || format === 'gzip') {
        const gunzip = createGunzip();
        gunzip.on('error', () => {});
        gunzip.end(raw);
        bytes = await collect(gunzip, maxExpanded, io.operation, expansionLimit);
      }
      if (bytes.length > maxExpanded) fail(CODE.LIMIT_EXCEEDED, expansionLimit);
      expandedBytes = bytes.length;
      if (format === 'gzip') {
        const entry = add(path.posix.basename(name).slice(0, -3) || 'content', false, bytes.length, 0o644);
        if (wanted(entry)) entry.content = bytes;
      } else {
        const extract = tar.extract();
        extract.on('error', () => {});
        const abort = () => extract.destroy(io.operation.signal.reason);
        io.operation.signal.addEventListener('abort', abort, { once: true });
        try {
          extract.end(bytes);
          for await (const stream of extract) {
            const header = stream.header;
            if (header.type !== 'file' && header.type !== 'directory') fail(CODE.INVALID_ARCHIVE);
            const entry = add(header.name, header.type === 'directory', header.size, header.mode);
            if (wanted(entry)) {
              const data = await collect(stream, security.maxExtractBytes, io.operation);
              if (data.length !== header.size) fail(CODE.INVALID_ARCHIVE);
              entry.content = data;
            } else {
              let size = 0;
              for await (const bytes of stream) { io.operation.check(); size += bytes.length; }
              if (size !== header.size) fail(CODE.INVALID_ARCHIVE);
            }
          }
        } finally { io.operation.signal.removeEventListener('abort', abort); extract.destroy(); }
      }
    }
    io.operation.check();
    return { format, entries, bytesRead: raw.length, expandedBytes };
  } catch (error) {
    if (error instanceof FsError) { error.archiveBytesRead = raw.length; error.archiveExpandedBytes = expandedBytes; throw error; }
    io.operation.check();
    const invalid = new FsError(CODE.INVALID_ARCHIVE);
    invalid.archiveBytesRead = raw.length;
    invalid.archiveExpandedBytes = expandedBytes;
    throw invalid;
  }
}

export async function readArchive(io, absolute, args, security) {
  const archive = await loadArchive(io, absolute, args.path, security, { content: args.mode !== 'list', selection: args.entry ?? null });
  const meta = { ...newMeta(), bytesRead: archive.bytesRead, expandedBytes: archive.expandedBytes };
  if (args.mode === 'list') {
    const selected = archive.entries.slice(args.offset, args.offset + args.limit);
    let nextOffset = null;
    if (args.offset + selected.length < archive.entries.length) { nextOffset = args.offset + selected.length; mark(meta, REASON.RESULTS); }
    return { data: { path: args.path, format: archive.format, entries: selected.map((entry) => ({ entry: entry.name, type: entry.type, size: entry.size })), totalEntries: archive.entries.length, nextOffset }, meta };
  }
  const files = archive.entries.filter((entry) => entry.type === 'file');
  let entry;
  if (args.entry !== undefined) entry = files.find((entry) => entry.name === args.entry);
  else if (files.length === 1) entry = files[0];
  else if (files.length > 1) fail(CODE.INVALID_ARGUMENT, 'entry.required');
  if (!entry) fail(CODE.NOT_FOUND);
  if (args.mode === 'tail') {
    let position = entry.size;
    let inspected = 0;
    let newlines = 0;
    while (position > 0 && inspected < security.maxReadBytes && newlines <= args.lines) {
      const length = Math.min(LIMIT.CHUNK, security.maxReadBytes - inspected, position);
      position -= length; inspected += length;
      for (const byte of entry.content.subarray(position, position + length)) if (byte === 10) newlines++;
    }
    const tail = tailText(entry.content.subarray(position), position > 0, args.lines, meta);
    return { data: { path: args.path, entry: entry.name, ...tail }, meta };
  }
  const end = Math.min(entry.size, args.offset + args.maxBytes);
  const bytes = entry.content.subarray(args.offset, end);
  const content = decodeText(bytes, { partialEnd: end < entry.size, offset: args.offset });
  const bytesReturned = Buffer.byteLength(content);
  if (bytes.length && !bytesReturned) fail(CODE.INVALID_ARGUMENT);
  const nextOffset = args.offset + bytesReturned;
  if (nextOffset < entry.size) mark(meta, REASON.READ);
  return { data: { path: args.path, entry: entry.name, content, encoding: 'utf-8', bytesReturned, nextOffset, eof: nextOffset >= entry.size }, meta };
}

async function inspectFuture(io, absolute, boundary, plannedDirectories) {
  const relative = path.posix.relative(boundary, absolute);
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) fail(CODE.PATH_OUT_OF_SCOPE);
  await inspectPath(io, boundary, 'directory');
  let current = boundary;
  const parts = relative.split('/').filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.posix.join(current, parts[index]);
    let attrs;
    try { attrs = await io.call('lstat', current); }
    catch (error) {
      if (error.code !== CODE.NOT_FOUND) throw error;
      if (index < parts.length - 1 && !plannedDirectories.has(current)) throw error;
      return null;
    }
    checkType(attrs, index < parts.length - 1 ? 'directory' : undefined);
    if (index === parts.length - 1) return attrs;
  }
  return await inspectPath(io, boundary, 'directory');
}

export async function extractArchive(io, absolute, destination, args, security) {
  const archive = await loadArchive(io, absolute, args.path, security, { content: true });
  const directories = new Set([destination.absolute]);
  for (let parent = path.posix.dirname(destination.absolute); parent !== destination.mount.path && destination.absolute !== destination.mount.path; parent = path.posix.dirname(parent)) {
    if (parent === '/' || !parent.startsWith(destination.mount.path + '/')) fail(CODE.PATH_OUT_OF_SCOPE);
    directories.add(parent);
  }
  const files = [];
  for (const entry of archive.entries) {
    const target = resolvePath(destination.absolute, entry.name);
    if (entry.type === 'directory') directories.add(target);
    else files.push({ entry, target });
    for (let parent = path.posix.dirname(target); parent !== destination.mount.path; parent = path.posix.dirname(parent)) {
      if (parent === '/' || !parent.startsWith(destination.mount.path + '/')) fail(CODE.PATH_OUT_OF_SCOPE);
      directories.add(parent);
    }
  }
  for (const directory of directories) {
    const attrs = await inspectFuture(io, directory, destination.mount.path, directories);
    if (attrs) checkType(attrs, 'directory');
  }
  for (const file of files) {
    const attrs = await inspectFuture(io, file.target, destination.mount.path, directories);
    if (attrs) {
      checkType(attrs, 'file');
      if (!args.overwrite) fail(CODE.ALREADY_EXISTS);
    }
  }
  let directoriesCreated = 0;
  for (const directory of [...directories].sort((a, b) => a.length - b.length)) {
    if (await ensureDirectory(io, directory, true, destination.mount.path)) directoriesCreated++;
  }
  let bytesWritten = 0;
  for (const { entry, target } of files) {
    let mode = 'create';
    if (args.overwrite) mode = 'overwrite';
    await writeBytes(io, target, entry.content, mode, entry.mode);
    bytesWritten += entry.content.length;
  }
  return { data: { path: args.path, destinationMountId: args.destinationMountId ?? args.mountId, destinationPath: args.destinationPath, filesWritten: files.length, directoriesCreated, bytesWritten }, meta: { ...newMeta(), bytesRead: archive.bytesRead, bytesWritten, expandedBytes: archive.expandedBytes } };
}
