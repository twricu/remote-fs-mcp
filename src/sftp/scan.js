import path from 'node:path';
import { CODE, FsError } from '../common/errors.js';
import { LIMIT, REASON } from '../common/constants.js';
import { inspectPath, safeName } from '../security/path-policy.js';
import { metadata, newMeta, mark, skip, openFile, readRange } from './read.js';
import { TextSearch, matchesPattern } from './search-text.js';
import { archiveFormat, loadArchive } from './archive.js';

export function fits(data, meta) {
  const result = { ok: true, data, meta };
  const text = JSON.stringify(result);
  return Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text }], structuredContent: result, isError: false })) <= LIMIT.RESULT;
}

export async function listDirectory(io, absolute, args, security) {
  const handle = await io.open(absolute, true);
  const entries = [];
  const meta = newMeta();
  let examined = 0;
  let position = 0;
  let nextOffset = null;
  try {
    outer: while (true) {
      const batch = await io.call('readdir', handle, { full: true });
      if (batch === false) break;
      if (!Array.isArray(batch) || !batch.length) throw new FsError(CODE.REMOTE_ERROR);
      for (const entry of batch) {
        io.operation.check();
        if (entry.filename === '.' || entry.filename === '..') continue;
        const index = position++;
        if (index < args.offset) continue;
        if (++examined > security.maxDirectoryEntries) { mark(meta, REASON.ENTRIES); nextOffset = index; break outer; }
        if (!safeName(entry.filename)) { skip(meta, 'invalidName'); continue; }
        const relative = path.posix.join(args.path, entry.filename);
        const target = path.posix.join(absolute, entry.filename);
        let attrs;
        try { attrs = await inspectPath(io, target); }
        catch (error) {
          if (error.code === CODE.SYMLINK_DENIED) { skip(meta, 'symlink'); continue; }
          if (error.code === CODE.NOT_REGULAR_FILE) { skip(meta, 'special'); continue; }
          throw error;
        }
        if (entries.length >= args.limit) { mark(meta, REASON.RESULTS); nextOffset = index; break outer; }
        entries.push({ name: entry.filename, ...metadata(attrs, relative) });
        if (!fits({ entries, nextOffset: position }, meta)) { entries.pop(); mark(meta, REASON.OUTPUT); nextOffset = index; break outer; }
      }
    }
  } finally { await io.closeHandle(handle); }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { data: { entries, nextOffset }, meta };
}

export async function searchFiles(io, absolute, args, security) {
  const meta = { ...newMeta(), entriesScanned: 0, filesScanned: 0, scanBytes: 0 };
  const matches = [];
  let stopped = false;
  const stop = () => { stopped = true; };
  const searcher = (location) => new TextSearch(args, security, meta, matches, location, stop, fits);
  const remaining = () => Math.max(0, security.maxScanBytes - meta.scanBytes);
  const scanBuffer = (content, location) => {
    const start = matches.length;
    const text = searcher(location);
    let offset = 0;
    try {
      while (offset < content.length && !stopped) {
        io.operation.check();
        const bytes = content.subarray(offset, Math.min(content.length, offset + LIMIT.CHUNK));
        offset += bytes.length;
        text.push(bytes);
      }
      text.finish(offset >= content.length);
    } catch (error) {
      if (error.code === CODE.UNSUPPORTED_CONTENT) { matches.splice(start); skip(meta, 'binary'); }
      else throw error;
    }
  };
  const scanArchive = async (target, relative) => {
    const budget = remaining();
    try {
      const archive = await loadArchive(io, target, relative, { ...security, maxOperationEntries: Math.max(0, security.maxOperationEntries - meta.entriesScanned) }, { content: true, processingBudget: budget });
      meta.bytesRead += archive.bytesRead; meta.scanBytes += archive.bytesRead + archive.expandedBytes;
      for (const entry of archive.entries) {
        if (stopped) break;
        if (++meta.entriesScanned > security.maxOperationEntries) { mark(meta, REASON.ENTRIES); stop(); break; }
        if (entry.type === 'file') scanBuffer(entry.content, { path: relative, entry: entry.name });
      }
    } catch (error) {
      meta.bytesRead += error.archiveBytesRead ?? 0;
      meta.scanBytes += (error.archiveBytesRead ?? 0) + (error.archiveExpandedBytes ?? 0);
      if (error.code === CODE.LIMIT_EXCEEDED) {
        if (error.detail === 'archive.entries') { mark(meta, REASON.ENTRIES); stop(); }
        else if (error.detail === 'scan.bytes') { mark(meta, REASON.SCAN); stop(); }
        else { skip(meta, 'archiveLimit'); mark(meta, REASON.SKIPPED); }
      }
      else if (error.code === CODE.INVALID_ARCHIVE || error.code === CODE.UNSUPPORTED_ARCHIVE) { skip(meta, 'archive'); mark(meta, REASON.SKIPPED); }
      else throw error;
    }
  };
  async function scanFile(target, relative) {
    if (!remaining()) { mark(meta, REASON.SCAN); stop(); return; }
    meta.filesScanned++;
    if (args.includeArchives && archiveFormat(relative)) { await scanArchive(target, relative); return; }
    const { handle, size } = await openFile(io, target);
    const start = matches.length;
    try {
      const text = searcher({ path: relative });
      const maximum = Math.min(size, remaining());
      let offset = 0;
      while (offset < maximum && !stopped) {
        const wanted = Math.min(LIMIT.CHUNK, maximum - offset);
        const bytes = await readRange(io, handle, offset, wanted);
        offset += bytes.length; meta.bytesRead += bytes.length; meta.scanBytes += bytes.length;
        text.push(bytes);
        if (bytes.length < wanted) { mark(meta, REASON.CHANGED); break; }
      }
      text.finish(offset >= size);
      if (offset < size && !stopped && meta.scanBytes >= security.maxScanBytes) { mark(meta, REASON.SCAN); stop(); }
    } catch (error) {
      if (error.code === CODE.UNSUPPORTED_CONTENT) { matches.splice(start); skip(meta, 'binary'); }
      else throw error;
    } finally { await io.closeHandle(handle); }
  }
  async function walk(directory, relative, depth) {
    const handle = await io.open(directory, true);
    let examined = 0;
    try {
      outer: while (!stopped) {
        const batch = await io.call('readdir', handle, { full: true });
        if (batch === false) break;
        if (!Array.isArray(batch) || !batch.length) throw new FsError(CODE.REMOTE_ERROR);
        for (const entry of batch) {
          io.operation.check();
          if (stopped) break outer;
          if (entry.filename === '.' || entry.filename === '..') continue;
          if (++examined > security.maxDirectoryEntries) { mark(meta, REASON.ENTRIES); break outer; }
          if (++meta.entriesScanned > security.maxOperationEntries) { mark(meta, REASON.ENTRIES); stop(); break outer; }
          if (!safeName(entry.filename)) { skip(meta, 'invalidName'); continue; }
          const target = path.posix.join(directory, entry.filename);
          const child = path.posix.join(relative, entry.filename);
          try {
            const attrs = await inspectPath(io, target);
            if (attrs.isDirectory()) {
              if (depth < args.maxDepth) await walk(target, child, depth + 1);
              else mark(meta, REASON.DEPTH);
            } else if (matchesPattern(entry.filename, args.filePattern)) await scanFile(target, child);
          } catch (error) {
            if (error.code === CODE.SYMLINK_DENIED) skip(meta, 'symlink');
            else if (error.code === CODE.NOT_REGULAR_FILE) skip(meta, 'special');
            else if ([CODE.NOT_FOUND, CODE.PERMISSION_DENIED].includes(error.code)) { skip(meta, 'unavailable'); mark(meta, REASON.SKIPPED); }
            else throw error;
          }
        }
      }
    } finally { await io.closeHandle(handle); }
  }
  await walk(absolute, args.path, 0);
  return { data: { matches }, meta };
}
