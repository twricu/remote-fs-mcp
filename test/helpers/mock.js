import { EventEmitter } from 'node:events';
import path from 'node:path';
import { DEFAULTS } from '../../src/common/constants.js';
import { SftpIO } from '../../src/sftp/operations.js';
import { FileService } from '../../src/tools/service.js';

export function attrs(node) {
  const modes = { directory: 0o040755, file: 0o100644, symlink: 0o120777, fifo: 0o010600 };
  const mode = (modes[node.type] & 0o170000) | (node.permissions ?? (modes[node.type] & 0o777));
  return { mode, size: node.content?.length ?? 0, mtime: 1700000000, atime: 1700000000, uid: 1000, gid: 1000,
    isFile: () => node.type === 'file', isDirectory: () => node.type === 'directory', isSymbolicLink: () => node.type === 'symlink' };
}
export function tree() {
  return new Map([
    ['/', { type: 'directory' }], ['/mnt', { type: 'directory' }], ['/mnt/logs', { type: 'directory' }],
    ['/mnt/logs/a.txt', { type: 'file', content: Buffer.from('first\nHello world\nlast\n') }],
    ['/mnt/logs/empty', { type: 'file', content: Buffer.alloc(0) }],
    ['/mnt/logs/unicode', { type: 'file', content: Buffer.from('中文😀hello\r\n第二行\n') }],
    ['/mnt/logs/sub', { type: 'directory' }],
    ['/mnt/logs/sub/deep.txt', { type: 'file', content: Buffer.from('Hello nested\n') }],
    ['/mnt/logs/link', { type: 'symlink' }], ['/mnt/logs/pipe', { type: 'fifo' }],
    ['/mnt/logs/binary', { type: 'file', content: Buffer.from([0, 1, 2]) }]
  ]);
}
export class MockChannel extends EventEmitter {
  constructor(nodes, calls = [], options = {}) { super(); this.nodes = nodes; this.calls = calls; this.handles = new Map(); this.serial = 0; this.options = options; this.destroyed = false; }
  respond(method, args, callback, work) {
    this.calls.push({ method, args });
    if (this.options.hang === method) return;
    const run = () => {
      if (this.destroyed) return;
      try { callback(null, ...work()); }
      catch (error) { callback(error); }
    };
    queueMicrotask(run);
  }
  node(file) { const node = this.nodes.get(file); if (!node) throw Object.assign(new Error('not found'), { code: 2 }); if (node.denied) throw Object.assign(new Error('denied'), { code: 3 }); return node; }
  lstat(file, callback) { this.respond('lstat', [file], callback, () => [attrs(this.node(file))]); }
  open(file, flags, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    this.respond('open', [file, flags], callback, () => {
      let create; let exclusive; let truncate; let append;
      if (typeof flags === 'number') {
        create = Boolean(flags & 8); exclusive = Boolean(flags & 32); truncate = Boolean(flags & 16); append = Boolean(flags & 4);
      } else { create = /[wa]/u.test(flags); exclusive = flags.includes('x'); truncate = flags.startsWith('w'); append = flags.startsWith('a'); }
      let node = this.nodes.get(file);
      if (node && exclusive) throw Object.assign(new Error('exists'), { code: 11 });
      if (!node && create) {
        if (this.node(path.posix.dirname(file)).type !== 'directory') throw Object.assign(new Error('parent'), { code: 4 });
        node = { type: 'file', content: Buffer.alloc(0), permissions: options?.mode ?? 0o644 };
        this.nodes.set(file, node);
      }
      node = this.node(file);
      if (truncate && node.type === 'file') node.content = Buffer.alloc(0);
      const handle = Buffer.from(String(++this.serial));
      this.handles.set(handle.toString(), { file, node, append });
      return [handle];
    });
  }
  opendir(file, callback) {
    this.respond('opendir', [file], callback, () => {
      this.node(file);
      const names = [...this.nodes.keys()].filter((name) => name !== file && path.posix.dirname(name) === file);
      const handle = Buffer.from(String(++this.serial));
      this.handles.set(handle.toString(), { file, names, position: 0 });
      return [handle];
    });
  }
  readdir(handle, options, callback) {
    if (typeof options === 'function') callback = options;
    this.respond('readdir', [handle], callback, () => {
      const state = this.handles.get(handle.toString());
      if (state.position >= state.names.length) return [false];
      const names = state.names.slice(state.position, state.position + 2);
      state.position += names.length;
      return [names.map((file) => ({ filename: path.posix.basename(file), attrs: attrs(this.node(file)) }))];
    });
  }
  fstat(handle, callback) { this.respond('fstat', [handle], callback, () => [attrs(this.handles.get(handle.toString()).node)]); }
  fsetstat(handle, changes, callback) {
    this.respond('fsetstat', [handle, changes], callback, () => {
      const node = this.handles.get(handle.toString()).node;
      if (changes.size !== undefined) { const content = Buffer.alloc(changes.size); node.content.copy(content); node.content = content; }
      return [];
    });
  }
  read(handle, buffer, offset, length, position, callback) {
    this.respond('read', [handle, length, position], callback, () => {
      const node = this.handles.get(handle.toString()).node;
      const bytes = node.content.subarray(position, position + length);
      bytes.copy(buffer, offset);
      return [bytes.length, buffer, position];
    });
  }
  write(handle, buffer, offset, length, position, callback) {
    this.respond('write', [handle, length, position], callback, () => {
      const state = this.handles.get(handle.toString());
      const node = state.node;
      if (state.append) position = node.content.length;
      const content = Buffer.alloc(Math.max(node.content.length, position + length));
      node.content.copy(content); buffer.copy(content, position, offset, offset + length); node.content = content;
      return [];
    });
  }
  mkdir(file, options, callback) {
    this.respond('mkdir', [file], callback, () => {
      if (this.nodes.has(file)) throw Object.assign(new Error('exists'), { code: 11 });
      if (this.node(path.posix.dirname(file)).type !== 'directory') throw Object.assign(new Error('parent'), { code: 4 });
      this.nodes.set(file, { type: 'directory', permissions: options?.mode ?? 0o755 }); return [];
    });
  }
  unlink(file, callback) { this.respond('unlink', [file], callback, () => { this.node(file); this.nodes.delete(file); return []; }); }
  rmdir(file, callback) {
    this.respond('rmdir', [file], callback, () => {
      this.node(file);
      if ([...this.nodes.keys()].some((name) => name.startsWith(file + '/'))) throw Object.assign(new Error('not empty'), { code: 18 });
      this.nodes.delete(file); return [];
    });
  }
  rename(source, destination, callback) {
    this.respond('rename', [source, destination], callback, () => {
      this.node(source); this.node(path.posix.dirname(destination));
      if (this.nodes.has(destination)) throw Object.assign(new Error('exists'), { code: 11 });
      const items = [...this.nodes].filter(([name]) => name === source || name.startsWith(source + '/'));
      for (const [name] of items) this.nodes.delete(name);
      for (const [name, node] of items) this.nodes.set(destination + name.slice(source.length), node);
      return [];
    });
  }
  ext_openssh_rename(source, destination, callback) {
    this.respond('ext_openssh_rename', [source, destination], callback, () => {
      this.node(source); this.node(path.posix.dirname(destination));
      this.nodes.delete(destination);
      const items = [...this.nodes].filter(([name]) => name === source || name.startsWith(source + '/'));
      for (const [name] of items) this.nodes.delete(name);
      for (const [name, node] of items) this.nodes.set(destination + name.slice(source.length), node);
      return [];
    });
  }
  close(handle, callback) { this.respond('close', [handle], callback, () => { this.handles.delete(handle.toString()); return []; }); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.handles.clear(); this.emit('close'); } }
}
export function mockService({ nodes = tree(), security = {}, permissions = ['read'], channelOptions = {} } = {}) {
  const calls = [];
  const channels = [];
  const logs = [];
  let connections = 0;
  const mount = { id: 'logs', path: '/mnt/logs', permissions };
  const server = { id: 'test', mounts: new Map([['logs', mount]]) };
  const config = { servers: new Map([['test', server]]), security: { ...DEFAULTS, ...security } };
  const service = new FileService(config, { connections: { get: async () => { connections++; return {}; }, close() {} },
    open: async (_client, operation) => { const channel = new MockChannel(nodes, calls, channelOptions); channels.push(channel); return new SftpIO(channel, operation); },
    log: (...args) => logs.push(args) });
  return { service, nodes, calls, channels, logs, mount, config, connectionCount: () => connections };
}
export const params = (path = '.') => ({ serverId: 'test', mountId: 'logs', path });
