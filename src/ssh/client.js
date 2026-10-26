import ssh2 from 'ssh2';
import { CONNECTION_STATE } from '../common/constants.js';
import { CODE, FsError } from '../common/errors.js';

export class Connections {
  constructor(timeoutMs) { this.timeoutMs = timeoutMs; this.entries = new Map(); this.closed = false; }
  start(server) {
    const client = new ssh2.Client();
    const entry = { client, state: CONNECTION_STATE.CONNECTING, waiters: 0 };
    this.entries.set(server.id, entry);
    let denied = false;
    entry.promise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { entry.state = CONNECTION_STATE.DISCONNECTED; reject(error); client.destroy(); }
        else { entry.state = CONNECTION_STATE.READY; resolve(client); }
      };
      const timer = setTimeout(() => finish(new FsError(CODE.TIMEOUT)), this.timeoutMs);
      client.on('error', (error) => {
        let code = CODE.REMOTE_ERROR;
        if (denied) code = CODE.HOST_KEY_REJECTED;
        else if (error.level === 'client-authentication') code = CODE.AUTH_FAILED;
        else if (error.level === 'client-timeout') code = CODE.TIMEOUT;
        finish(new FsError(code));
      });
      client.on('close', () => {
        entry.state = CONNECTION_STATE.DISCONNECTED;
        let code = CODE.REMOTE_ERROR;
        if (denied) code = CODE.HOST_KEY_REJECTED;
        finish(new FsError(code));
      });
      client.once('ready', () => finish());
      try {
        client.connect({ host: server.host, port: server.port, username: server.username,
          readyTimeout: this.timeoutMs, tryKeyboard: false, agentForward: false,
          hostVerifier: (key) => { const allowed = server.verifier(key); if (!allowed) denied = true; return allowed; },
          authHandler: server.methods.map((method) => ({ ...method, username: server.username })) });
      } catch (_error) { finish(new FsError(CODE.REMOTE_ERROR)); }
    });
    // A cancelled last waiter must never leave an unhandled connection rejection.
    entry.promise.catch(() => {});
    return entry;
  }
  async get(server, operation) {
    operation.check();
    if (this.closed) throw new FsError(CODE.CANCELLED);
    let entry = this.entries.get(server.id);
    if (!entry || entry.state === CONNECTION_STATE.DISCONNECTED) entry = this.start(server);
    entry.waiters++;
    try { return await operation.wait(entry.promise); }
    finally {
      entry.waiters--;
      if (entry.state === CONNECTION_STATE.CONNECTING && entry.waiters === 0) entry.client.destroy();
    }
  }
  close() {
    this.closed = true;
    for (const entry of this.entries.values()) { entry.state = CONNECTION_STATE.CLOSING; entry.client.destroy(); }
    this.entries.clear();
  }
}
