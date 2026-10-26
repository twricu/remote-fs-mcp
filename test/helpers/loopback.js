import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import ssh2 from 'ssh2';
import { MockChannel, tree } from './mock.js';
import { testKey } from './keys.js';
function bridge(sftp, nodes, calls) {
  const backend = new MockChannel(nodes, calls);
  const status = (id, error) => sftp.status(id, error?.code ?? 4);
  sftp.on('LSTAT', (id, file) => backend.lstat(file, (error, attrs) => { if (error) status(id, error); else sftp.attrs(id, attrs); }));
  sftp.on('OPEN', (id, file, flags, attrs) => {
    backend.open(file, flags, attrs, (error, handle) => { if (error) status(id, error); else sftp.handle(id, handle); });
  });
  sftp.on('OPENDIR', (id, file) => backend.opendir(file, (error, handle) => { if (error) status(id, error); else sftp.handle(id, handle); }));
  sftp.on('READDIR', (id, handle) => backend.readdir(handle, (error, entries) => {
    if (error) status(id, error);
    else if (entries === false) sftp.status(id, 1);
    else sftp.name(id, entries.map((entry) => ({ ...entry, longname: entry.filename })));
  }));
  sftp.on('FSTAT', (id, handle) => backend.fstat(handle, (error, attrs) => { if (error) status(id, error); else sftp.attrs(id, attrs); }));
  sftp.on('FSETSTAT', (id, handle, attrs) => backend.fsetstat(handle, attrs, (error) => { if (error) status(id, error); else sftp.status(id, 0); }));
  sftp.on('WRITE', (id, handle, position, bytes) => backend.write(handle, bytes, 0, bytes.length, position, (error) => { if (error) status(id, error); else sftp.status(id, 0); }));
  sftp.on('MKDIR', (id, file, attrs) => backend.mkdir(file, attrs, (error) => { if (error) status(id, error); else sftp.status(id, 0); }));
  sftp.on('REMOVE', (id, file) => backend.unlink(file, (error) => { if (error) status(id, error); else sftp.status(id, 0); }));
  sftp.on('RMDIR', (id, file) => backend.rmdir(file, (error) => { if (error) status(id, error); else sftp.status(id, 0); }));
  sftp.on('RENAME', (id, source, destination) => backend.rename(source, destination, (error) => { if (error) status(id, error); else sftp.status(id, 0); }));
  sftp.on('READ', (id, handle, offset, length) => {
    const state = backend.handles.get(handle.toString());
    if (nodes.get(state?.file)?.hangRead) { calls.push({ method: 'hanging-read' }); return; }
    const buffer = Buffer.alloc(Math.min(length, 1048576));
    backend.read(handle, buffer, 0, buffer.length, offset, (error, count) => {
      if (error) status(id, error);
      else if (count === 0) sftp.status(id, 1);
      else sftp.data(id, buffer.subarray(0, count));
    });
  });
  sftp.on('CLOSE', (id, handle) => backend.close(handle, (error) => { if (error) status(id, error); else sftp.status(id, 0); }));
  sftp.on('close', () => backend.destroy());
  sftp.on('error', () => {});
}
export async function loopback(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rfm-'));
  const key = testKey();
  const password = randomBytes(24).toString('hex');
  const clients = new Set();
  const sockets = new Set();
  let server;
  let agent;
  t.after(async () => {
    for (const client of clients) client.end();
    for (const socket of sockets) socket.destroy();
    if (server?.address()) await new Promise((resolve) => server.close(resolve));
    if (agent?.listening) await new Promise((resolve) => agent.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const calls = [];
  const nodes = tree();
  let connectionCount = 0;
  server = new ssh2.Server({ hostKeys: [key.pem] }, (client) => {
    connectionCount++;
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', (context) => {
      if (context.username !== 'fixture') return context.reject();
      if (context.method === 'password' && context.password === password) return context.accept();
      if (context.method === 'publickey' && context.key.data.equals(key.blob) && (!context.signature || key.parsed.verify(context.blob, context.signature, context.hashAlgo) === true)) return context.accept();
      context.reject(['password', 'publickey']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (_accept, reject) => reject());
      session.on('shell', (_accept, reject) => reject());
      session.on('sftp', (acceptSftp) => bridge(acceptSftp(), nodes, calls));
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const knownHosts = path.join(directory, 'known_hosts');
  const keyFile = path.join(directory, 'identity');
  await writeFile(knownHosts, `[127.0.0.1]:${port} ssh-rsa ${key.blob.toString('base64')}\n`);
  await writeFile(keyFile, key.pem, { mode: 0o600 });
  agent = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const protocol = new ssh2.AgentProtocol(false);
    protocol.on('error', () => socket.destroy());
    protocol.on('identities', (request) => protocol.getIdentitiesReply(request, [{ pubKey: key.parsed, comment: 'temporary test identity' }]));
    protocol.on('sign', (request, _publicKey, data, options) => {
      const signature = key.parsed.sign(data, options.hash);
      if (signature instanceof Error) protocol.failureReply(request);
      else protocol.signReply(request, signature);
    });
    socket.pipe(protocol).pipe(socket);
  });
  let endpoint = path.join(directory, 'agent.sock');
  if (process.platform === 'win32') endpoint = `\\\\.\\pipe\\remote-fs-${randomUUID()}`;
  await new Promise((resolve, reject) => { agent.once('error', reject); agent.listen(endpoint, resolve); });
  const config = (auth = { type: 'password', password: password }, permissions) => ({ version: 1, servers: [{ id: 'test', connection: { host: '127.0.0.1', port, username: 'fixture', auth, knownHostsFile: knownHosts }, mounts: [{ id: 'logs', path: '/mnt/logs', ...(permissions ? { permissions } : {}) }] }] });
  async function writeConfig(auth, name = 'config.yaml', permissions) {
    const file = path.join(directory, name);
    await writeFile(file, stringify(config(auth, permissions)), { mode: 0o600 });
    return file;
  }
  return { directory, password, keyFile, key, port, knownHosts, endpoint, config, writeConfig, calls, nodes, connectionCount: () => connectionCount };
}
