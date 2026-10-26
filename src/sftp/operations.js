import { CODE, FsError, safeError } from '../common/errors.js';

export class SftpIO {
  constructor(channel, operation) {
    this.channel = channel;
    this.operation = operation;
    this.handles = new Set();
    this.closing = false;
    this.abort = () => channel.destroy();
    this.onClose = () => { if (!this.closing) operation.abort(new FsError(CODE.REMOTE_ERROR)); };
    channel.on('error', this.onClose);
    channel.on('close', this.onClose);
    operation.signal.addEventListener('abort', this.abort, { once: true });
    if (operation.signal.aborted) this.abort();
  }
  call(method, ...args) {
    this.operation.check();
    const pending = new Promise((resolve, reject) => {
      this.channel[method](...args, (error, ...values) => {
        if (error?.code === 1 && method === 'readdir') resolve(false);
        else if (error) reject(safeError(error));
        else if (values.length > 1) resolve(values);
        else resolve(values[0]);
      });
    });
    return this.operation.wait(pending);
  }
  async open(file, directory = false) {
    let handle;
    if (directory) handle = await this.call('opendir', file);
    else handle = await this.call('open', file, 'r');
    this.handles.add(handle);
    return handle;
  }
  async closeHandle(handle) {
    this.handles.delete(handle);
    await this.call('close', handle);
  }
  mutate(method, ...args) {
    this.operation.check();
    this.operation.mayHaveChanged = true;
    return this.call(method, ...args);
  }
  async openWrite(file, flags, mode = 0o644) {
    const handle = await this.mutate('open', file, flags, { mode });
    this.handles.add(handle);
    return handle;
  }
  async close() {
    this.closing = true;
    this.operation.signal.removeEventListener('abort', this.abort);
    if (!this.operation.signal.aborted) {
      const closing = [...this.handles].map((handle) => new Promise((resolve) => {
        try { this.channel.close(handle, resolve); } catch (_error) { resolve(); }
      }));
      let timer;
      await Promise.race([Promise.all(closing), new Promise((resolve) => { timer = setTimeout(resolve, 100); })]);
      clearTimeout(timer);
    }
    this.handles.clear();
    this.channel.destroy();
    this.channel.removeListener('error', this.onClose);
    this.channel.removeListener('close', this.onClose);
    // Keep a safe error listener for late transport errors.
    this.channel.on('error', () => {});
  }
}
export async function openSftp(client, operation) {
  const pending = new Promise((resolve, reject) => {
    client.sftp((error, channel) => {
      if (error) reject(new FsError(CODE.REMOTE_ERROR));
      else if (operation.signal.aborted) { channel.destroy(); reject(operation.signal.reason); }
      else resolve(new SftpIO(channel, operation));
    });
  });
  return operation.wait(pending);
}
