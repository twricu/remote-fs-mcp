import { CODE, fail, FsError, errorResult } from '../common/errors.js';
import { TOOL } from '../common/constants.js';
import { Operation, Semaphore } from '../security/limits.js';
import { authorize } from '../security/mount-policy.js';
import { inspectPath, resolvePath } from '../security/path-policy.js';
import { audit } from '../security/audit.js';
import { Connections } from '../ssh/client.js';
import { openSftp } from '../sftp/operations.js';
import { metadata, newMeta, readFile, tailFile } from '../sftp/read.js';
import { fits, listDirectory, searchFiles } from '../sftp/scan.js';
import { toolSchemas } from './schemas.js';
import { writeContent, writeFile, createDirectory, deletePath, movePath } from '../sftp/mutate.js';
import { readArchive, extractArchive } from '../sftp/archive.js';

export class FileService {
  constructor(config, { connections = new Connections(config.security.connectionTimeoutMs), open = openSftp, log = audit } = {}) {
    this.config = config;
    this.connections = connections;
    this.open = open;
    this.log = log;
    this.schemas = toolSchemas(config.security);
    this.semaphore = new Semaphore(config.security.maxConcurrentOperations);
    this.operations = new Set();
    this.closed = false;
  }
  async run(tool, params, signal) {
    const started = performance.now();
    const operation = new Operation(this.config.security.operationTimeoutMs, signal);
    this.operations.add(operation);
    let release;
    let io;
    let args;
    let result;
    try {
      if (this.closed) fail(CODE.CANCELLED);
      const schema = this.schemas.get(tool);
      if (!schema) fail(CODE.INVALID_ARGUMENT);
      const parsed = schema.safeParse(params);
      if (!parsed.success) fail(CODE.INVALID_ARGUMENT);
      args = parsed.data;
      operation.check();
      if (tool === TOOL.MOUNTS) {
        const mounts = [];
        for (const server of this.config.servers.values()) {
          for (const mount of server.mounts.values()) mounts.push({ serverId: server.id, mountId: mount.id, permissions: [...mount.permissions] });
        }
        result = { ok: true, data: { mounts }, meta: newMeta() };
      } else {
        const { server, mount, absolute, destination } = authorize(this.config, tool, args);
        let bytes;
        if (tool === TOOL.WRITE) bytes = writeContent(args, this.config.security);
        if (tool === TOOL.ARCHIVE && args.entry !== undefined) resolvePath('/archive', args.entry);
        release = await this.semaphore.acquire(operation);
        const client = await this.connections.get(server, operation);
        io = await this.open(client, operation);
        await inspectPath(io, mount.path, 'directory');
        if (destination) await inspectPath(io, destination.mount.path, 'directory');
        let output;
        if (tool === TOOL.WRITE) output = await writeFile(io, absolute, args, bytes);
        else if (tool === TOOL.MKDIR) output = await createDirectory(io, absolute, args, mount.path);
        else if (tool === TOOL.MOVE) output = await movePath(io, absolute, destination.absolute, args, this.config.security);
        else if (tool === TOOL.DELETE) output = await deletePath(io, absolute, args, this.config.security);
        else {
          let expected;
          if (tool === TOOL.DIRECTORY || tool === TOOL.SEARCH) expected = 'directory';
          else if (tool !== TOOL.STAT) expected = 'file';
          const attrs = await inspectPath(io, absolute, expected);
          if (tool === TOOL.DIRECTORY) output = await listDirectory(io, absolute, args, this.config.security);
          else if (tool === TOOL.STAT) output = { data: metadata(attrs, args.path), meta: newMeta() };
          else if (tool === TOOL.READ) output = await readFile(io, absolute, args);
          else if (tool === TOOL.TAIL) output = await tailFile(io, absolute, args, this.config.security);
          else if (tool === TOOL.ARCHIVE) output = await readArchive(io, absolute, args, this.config.security);
          else if (tool === TOOL.EXTRACT) output = await extractArchive(io, absolute, destination, args, this.config.security);
          else output = await searchFiles(io, absolute, args, this.config.security);
        }
        operation.check();
        result = { ok: true, ...output };
      }
      if (!fits(result.data, result.meta)) throw new FsError(CODE.LIMIT_EXCEEDED);
    } catch (error) { result = errorResult(error); }
    finally {
      if (io) {
        try { await io.close(); }
        catch (_error) { if (result?.ok) result = errorResult(new FsError(CODE.REMOTE_ERROR)); }
      }
      if (release) release();
      if (result?.ok) {
        try { operation.check(); }
        catch (error) { result = errorResult(error); }
      }
      operation.dispose();
      this.operations.delete(operation);
    }
    if (!result.ok && operation.mayHaveChanged) result.meta = { mayHaveChanged: true };
    let publicTool = 'unknown';
    if (this.schemas.has(tool)) publicTool = tool;
    const fields = { tool: publicTool, code: 'OK', durationMs: Math.round(performance.now() - started) };
    if (args) { fields.serverId = args.serverId; fields.mountId = args.mountId; }
    if (!result.ok) fields.code = result.error.code;
    else fields.bytesRead = result.meta.bytesRead;
    this.log('tool', fields);
    return result;
  }
  close() {
    this.closed = true;
    for (const operation of this.operations) operation.abort();
    this.connections.close();
  }
}
