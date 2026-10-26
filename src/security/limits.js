import { CODE, fail, FsError } from '../common/errors.js';
import { LIMIT } from '../common/constants.js';

export class Operation {
  constructor(timeoutMs, externalSignal) {
    this.deadline = performance.now() + timeoutMs;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.timer = setTimeout(() => this.abort(new FsError(CODE.TIMEOUT)), timeoutMs);
    this.externalSignal = externalSignal;
    this.onExternal = () => this.abort(new FsError(CODE.CANCELLED));
    externalSignal?.addEventListener('abort', this.onExternal, { once: true });
    if (externalSignal?.aborted) this.onExternal();
  }
  abort(reason = new FsError(CODE.CANCELLED)) { this.controller.abort(reason); }
  check() {
    if (!this.signal.aborted && performance.now() >= this.deadline) this.abort(new FsError(CODE.TIMEOUT));
    if (this.signal.aborted) throw this.signal.reason;
  }
  wait(promise) {
    if (this.signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(this.signal.reason); }
    return new Promise((resolve, reject) => {
      const abort = () => { this.signal.removeEventListener('abort', abort); reject(this.signal.reason); };
      this.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then((value) => { this.signal.removeEventListener('abort', abort); resolve(value); }, (error) => { this.signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  dispose() { clearTimeout(this.timer); this.externalSignal?.removeEventListener('abort', this.onExternal); }
}
export class Semaphore {
  constructor(maximum) { this.maximum = maximum; this.active = 0; this.queue = []; }
  async acquire(operation) {
    operation.check();
    if (this.active < this.maximum) { this.active++; return () => this.release(); }
    if (this.queue.length >= LIMIT.QUEUE) fail(CODE.LIMIT_EXCEEDED);
    let entry;
    const promise = new Promise((resolve) => { entry = { resolve }; this.queue.push(entry); });
    try { await operation.wait(promise); }
    catch (error) {
      const index = this.queue.indexOf(entry);
      if (index !== -1) this.queue.splice(index, 1);
      else this.release();
      throw error;
    }
    return () => this.release();
  }
  release() {
    const next = this.queue.shift();
    if (next) next.resolve();
    else this.active--;
  }
}
