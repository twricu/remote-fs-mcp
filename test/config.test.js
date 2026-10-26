import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { parseConfig, loadConfig } from '../src/config/load.js';
import { parseSshConfig } from '../src/ssh/ssh-config.js';

const sample = () => ({ version: 1, servers: [{ id: 'test', connection: { host: '192.0.2.10', username: 'deploy', auth: { type: 'password', password: 'test-only-secret' } }, mounts: [{ id: 'logs', path: '/mnt/logs' }] }] });
test('configuration supplies read-only defaults and accepts bounded larger byte budgets', () => {
  const result = parseConfig(stringify(sample()));
  assert.equal(result.security.maxReadBytes, 4194304);
  assert.equal(result.security.maxScanBytes, 268435456);
  assert.equal(result.security.followSymlinks, false);
  assert.deepEqual(result.servers[0].mounts[0].permissions, ['read']);
  const custom = sample();
  custom.security = { maxReadBytes: 16777216, maxScanBytes: 8589934592 };
  custom.servers[0].mounts[0] = { id: 'home', path: '/root', permissions: ['read', 'write', 'delete'] };
  const configured = parseConfig(stringify(custom));
  assert.equal(configured.security.maxReadBytes, 16777216);
  assert.equal(configured.security.maxScanBytes, 8589934592);
  assert.equal(configured.servers[0].mounts[0].path, '/root');
  assert.deepEqual(configured.servers[0].mounts[0].permissions, ['read', 'write', 'delete']);
});
test('one server can authorize many directories without a small mount-count cap', () => {
  const config = sample();
  config.servers[0].mounts = Array.from({ length: 40 }, (_, index) => ({ id: 'mount-' + index, path: '/srv/directory-' + index }));
  assert.equal(parseConfig(stringify(config)).servers[0].mounts.length, 40);
});
const invalid = [
  ['unknown field', (c) => { c.surprise = true; }], ['unknown nested field', (c) => { c.servers[0].connection.shell = 'x'; }],
  ['unknown permission', (c) => { c.servers[0].mounts[0].permissions = ['execute']; }],
  ['empty permissions', (c) => { c.servers[0].mounts[0].permissions = []; }],
  ['duplicate permissions', (c) => { c.servers[0].mounts[0].permissions = ['read', 'read']; }],
  ['root mount', (c) => { c.servers[0].mounts[0].path = '/'; }],
  ['relative mount', (c) => { c.servers[0].mounts[0].path = 'logs'; }],
  ['mount traversal', (c) => { c.servers[0].mounts[0].path = '/mnt/../logs'; }],
  ['conflicting passwords', (c) => { c.servers[0].connection.auth.passwordEnv = 'SECRET'; }],
  ['conflicting passphrases', (c) => { c.servers[0].connection.auth = { type: 'private-key', privateKeyPath: '/tmp/key', passphrase: 'test', passphraseEnv: 'SECRET' }; }],
  ['missing password', (c) => { delete c.servers[0].connection.auth.password; }],
  ['wrong auth fields', (c) => { c.servers[0].connection.auth.privateKeyPath = '/tmp/key'; }],
  ['string port', (c) => { c.servers[0].connection.port = '22'; }],
  ['host URL', (c) => { c.servers[0].connection.host = 'ssh://host'; }],
  ['server duplicate', (c) => { c.servers.push(structuredClone(c.servers[0])); }],
  ['mount duplicate', (c) => { c.servers[0].mounts.push(structuredClone(c.servers[0].mounts[0])); }],
  ['symlinks enabled', (c) => { c.security = { followSymlinks: true }; }],
  ['read hard cap', (c) => { c.security = { maxReadBytes: 16777217 }; }],
  ['scan hard cap', (c) => { c.security = { maxScanBytes: 8589934593 }; }],
  ['unbounded scan', (c) => { c.security = { maxScanBytes: 1e12 }; }],
  ['shell configuration', (c) => { c.security = { allowShell: true }; }]
];
test('configuration rejects unsafe permissions, paths, credentials and unknown fields', () => {
  for (const [name, change] of invalid) {
    const config = sample(); change(config);
    assert.throws(() => parseConfig(stringify(config)), { code: 'CONFIG_INVALID' }, name);
  }
});

test('configuration encoding, bounded files and safe error positions', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rfm-bounds-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.yaml');
  await writeFile(file, Buffer.from([0xff]));
  await assert.rejects(loadConfig(file), { code: 'CONFIG_INVALID' });
  await writeFile(file, Buffer.alloc(1048577, 32));
  await assert.rejects(loadConfig(file), { code: 'CONFIG_INVALID' });
  assert.throws(() => parseConfig('version: 1\npassword: "test-secret'), (error) => /yaml line 2/u.test(error.message) && !error.message.includes('test-secret'));
  const config = sample();
  config.servers[0].connection.port = 0;
  assert.throws(() => parseConfig(stringify(config)), (error) => error.message.includes('connection.port') && !error.message.includes('test-only-secret'));
});
test('YAML rejects duplicate keys, aliases, tags and multiple documents without exposing secrets', () => {
  const valid = stringify(sample());
  const malformed = [
    ['duplicate keys', `version: 1\n${valid}`],
    ['aliases', valid.replace('host: 192.0.2.10', 'host: &host 192.0.2.10').replace('username: deploy', 'username: *host')],
    ['custom tags', valid.replace('password: test-only-secret', 'password: !secret test-only-secret')],
    ['multiple documents', `${valid}---\n${valid}`],
    ['malformed secret', valid.replace('password: test-only-secret', 'password: "test-only-secret')]
  ];
  for (const [name, source] of malformed) {
    assert.throws(() => parseConfig(source), (error) => error.code === 'CONFIG_INVALID' && !JSON.stringify(error).includes('test-only-secret'), name);
  }
});
test('bounded OpenSSH subset honors first match and collects identities', () => {
  const result = parseSshConfig('Host app\n HostName example.com\n User deploy\n Port 2222\n IdentityFile ~/.ssh/one\nHost *\n User nobody\n IdentityFile ~/.ssh/two', 'app');
  assert.equal(result.user, 'deploy');
  assert.equal(result.port, '2222');
  assert.equal(result.hostname, 'example.com');
  assert.deepEqual(result.identities, ['~/.ssh/one', '~/.ssh/two']);
  assert.equal(parseSshConfig('Host other\n ProxyCommand ignored\nHost app\n User deploy', 'app').user, 'deploy');
});
test('SSH config rejects executable scopes and directives outside the supported subset', () => {
  const unsupported = ['Match exec "anything"', 'Include ~/.ssh/*', 'Host app\n ProxyJump jump', 'Host *\n StrictHostKeyChecking no', 'Host app*\nUser x', 'Host app\nIdentityFile %d/key'];
  for (const source of unsupported) assert.throws(() => parseSshConfig(source, 'app'), { code: 'CONFIG_INVALID' });
});
test('loader chooses one file and fails missing or empty environment references', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remote-fs-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = sample();
  config.servers[0].connection.knownHostsFile = 'known_hosts';
  await writeFile(path.join(directory, 'known_hosts'), '');
  const file = path.join(directory, 'config.yaml');
  await writeFile(file, stringify(config), { mode: 0o600 });
  const result = await loadConfig(file, { env: { REMOTE_FS_MCP_CONFIG: '/missing' }, home: directory });
  assert.equal(result.servers.get('test').port, 22);
  assert.equal(result.servers.get('test').methods[0].password, 'test-only-secret');
  delete config.servers[0].connection.auth.password;
  config.servers[0].connection.auth.passwordEnv = 'TEST_PASSWORD';
  await writeFile(file, stringify(config));
  for (const env of [{}, { TEST_PASSWORD: '' }]) await assert.rejects(loadConfig(file, { env }), { code: 'CONFIG_INVALID' });
  assert.equal((await loadConfig(file, { env: { TEST_PASSWORD: 'provided' } })).servers.get('test').methods[0].password, 'provided');
  await assert.rejects(loadConfig('', { env: {} }), { code: 'CONFIG_INVALID' });
  await assert.rejects(loadConfig('/missing/explicit', { env: { REMOTE_FS_MCP_CONFIG: file } }), { code: 'CONFIG_INVALID' });
  await mkdir(path.join(directory, '.remote-fs-mcp'));
  config.servers[0].connection.knownHostsFile = path.join(directory, 'known_hosts');
  await writeFile(path.join(directory, '.remote-fs-mcp/config.yaml'), stringify(config));
  assert.equal((await loadConfig(undefined, { home: directory, env: { TEST_PASSWORD: 'provided' } })).servers.size, 1);
});
