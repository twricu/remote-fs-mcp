import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config/load.js';
import { FileService } from '../src/tools/service.js';
import { loopback } from './helpers/loopback.js';
import { params } from './helpers/mock.js';

for (const type of ['password', 'password-env', 'private-key', 'agent']) test(`loopback SSH/SFTP authentication: ${type}`, { timeout: 15000 }, async (t) => {
  const fixture = await loopback(t);
  let auth = { type: 'password', password: fixture.password };
  if (type === 'password-env') auth = { type: 'password', passwordEnv: 'FIXTURE_PASSWORD' };
  else if (type === 'private-key') auth = { type, privateKeyPath: fixture.keyFile };
  else if (type === 'agent') auth = { type };
  const file = await fixture.writeConfig(auth);
  const config = await loadConfig(file, { home: fixture.directory, env: { FIXTURE_PASSWORD: fixture.password, SSH_AUTH_SOCK: fixture.endpoint } });
  const service = new FileService(config, { log() {} });
  t.after(() => service.close());
  const [one, two] = await Promise.all([service.run('read_file', params('a.txt')), service.run('stat_file', params('empty'))]);
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.equal(one.data.content, 'first\nHello world\nlast\n');
  assert.equal(two.data.size, 0);
  assert.equal(fixture.connectionCount(), 1);
});
test('auto reuses limited SSH Host/User/Port/IdentityFile without subprocesses', { timeout: 15000 }, async (t) => {
  const fixture = await loopback(t);
  await mkdir(path.join(fixture.directory, '.ssh'));
  await writeFile(path.join(fixture.directory, '.ssh/config'), `Host fixture-alias\n HostName 127.0.0.1\n User fixture\n Port ${fixture.port}\n IdentityFile "${fixture.keyFile}"\n`);
  const data = fixture.config({ type: 'auto' });
  data.servers[0].connection.host = 'fixture-alias';
  delete data.servers[0].connection.port;
  delete data.servers[0].connection.username;
  const file = path.join(fixture.directory, 'auto.yaml');
  await writeFile(file, stringify(data));
  const service = new FileService(await loadConfig(file, { home: fixture.directory, env: {} }), { log() {} });
  t.after(() => service.close());
  assert.equal((await service.run('read_file', params('a.txt'))).ok, true);
});

test('servers and mount IDs remain independently scoped', { timeout: 15000 }, async (t) => {
  const fixture = await loopback(t);
  const config = fixture.config();
  config.servers.push({ id: 'other', connection: structuredClone(config.servers[0].connection), mounts: [{ id: 'logs', path: '/mnt/logs/sub', permissions: ['read'] }] });
  const file = path.join(fixture.directory, 'multi.yaml');
  await writeFile(file, stringify(config));
  const service = new FileService(await loadConfig(file, { env: {} }), { log() {} });
  t.after(() => service.close());
  assert.equal((await service.run('list_mounts', {})).data.mounts.length, 2);
  const result = await service.run('read_file', { serverId: 'other', mountId: 'logs', path: 'deep.txt' });
  assert.equal(result.data.content, 'Hello nested\n');
  assert.equal((await service.run('read_file', params('a.txt'))).ok, true);
  assert.equal(fixture.connectionCount(), 2);
  assert.equal((await service.run('list_directory', { serverId: 'other', mountId: 'logs' })).ok, true);
  assert.equal((await service.run('write_file', { serverId: 'other', mountId: 'logs', path: 'new', content: 'x' })).error.code, 'PERMISSION_DENIED');
});
for (const mode of ['unknown-key', 'changed-key', 'revoked-key', 'bad-password']) test(`real SSH rejects ${mode}`, { timeout: 15000 }, async (t) => {
  const fixture = await loopback(t);
  if (mode === 'unknown-key') await writeFile(fixture.knownHosts, '');
  if (mode === 'changed-key') {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'sec1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const { default: ssh2 } = await import('ssh2');
    const other = ssh2.utils.parseKey(privateKey);
    await writeFile(fixture.knownHosts, `[127.0.0.1]:${fixture.port} ${other.type} ${other.getPublicSSH().toString('base64')}`);
  }
  if (mode === 'revoked-key') await writeFile(fixture.knownHosts, `@revoked * ssh-rsa ${fixture.key.blob.toString('base64')}`);
  const file = await fixture.writeConfig({ type: 'password', password: mode === 'bad-password' ? 'incorrect-test-value' : fixture.password });
  const service = new FileService(await loadConfig(file, { env: {} }), { log() {} });
  t.after(() => service.close());
  const result = await service.run('read_file', params('a.txt'));
  let code = 'HOST_KEY_REJECTED';
  if (mode === 'bad-password') code = 'AUTH_FAILED';
  assert.equal(result.error.code, code);
  assert.equal(fixture.calls.length, 0);
});

for (const mode of ['direct', 'environment']) test(`encrypted private key with ${mode} passphrase`, { timeout: 15000 }, async (t) => {
  const fixture = await loopback(t);
  const phrase = 'test-only-passphrase';
  const encrypted = createPrivateKey(fixture.key.pem).export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: phrase });
  await writeFile(fixture.keyFile, encrypted);
  const auth = { type: 'private-key', privateKeyPath: fixture.keyFile };
  if (mode === 'direct') auth.passphrase = phrase;
  else auth.passphraseEnv = 'TEST_KEY_PHRASE';
  const file = await fixture.writeConfig(auth);
  const service = new FileService(await loadConfig(file, { env: { TEST_KEY_PHRASE: phrase } }), { log() {} });
  t.after(() => service.close());
  assert.equal((await service.run('read_file', params('a.txt'))).ok, true);
  if (mode === 'direct') auth.passphrase = 'incorrect';
  else auth.passphraseEnv = 'INCORRECT_PHRASE';
  await assert.rejects(loadConfig(await fixture.writeConfig(auth), { env: { INCORRECT_PHRASE: 'incorrect' } }), { code: 'AUTH_FAILED' });
});
