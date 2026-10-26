import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { parseKnownHosts, createVerifier } from '../src/ssh/known-hosts.js';
import { testKey } from './helpers/keys.js';

test('known_hosts accepts exact records and rejects unknown/changed keys', () => {
  const key = testKey();
  const records = parseKnownHosts(`example.com,192.0.2.10 ssh-rsa ${key.blob.toString('base64')} comment`);
  assert.equal(createVerifier(records, 'example.com', 22)(key.blob), true);
  assert.equal(createVerifier(records, '192.0.2.10', 22)(key.blob), true);
  assert.equal(createVerifier(records, 'unknown', 22)(key.blob), false);
  assert.equal(createVerifier(records, 'example.com', 22)(Buffer.from('changed')), false);
});
test('hashed host identity includes non-default ports and IPv6', () => {
  const key = testKey();
  for (const [host, port] of [['example.com', 2222], ['::1', 2222], ['192.0.2.10', 22]]) {
    const salt = randomBytes(20);
    let identifier = host;
    if (port !== 22) identifier = `[${host}]:${port}`;
    const digest = createHmac('sha1', salt).update(identifier).digest('base64');
    const records = parseKnownHosts(`|1|${salt.toString('base64')}|${digest} ssh-rsa ${key.blob.toString('base64')}`);
    assert.equal(createVerifier(records, host, port)(key.blob), true, host);
    assert.equal(createVerifier(records, 'other', port)(key.blob), false);
  }
});
test('revoked key wins over an ordinary trusted record', () => {
  const key = testKey();
  const line = `ssh-rsa ${key.blob.toString('base64')}`;
  for (const names of ['example.com', '*']) {
    const records = parseKnownHosts(`example.com ${line}\n@revoked ${names} ${line}`);
    assert.equal(createVerifier(records, 'example.com', 22)(key.blob), false);
  }
});
test('unsupported host patterns and markers are rejected even with valid public keys', () => {
  const publicKey = `ssh-rsa ${testKey().blob.toString('base64')}`;
  const unsupported = [
    ['certificate authority', `@cert-authority example.com ${publicKey}`],
    ['wildcard trust', `*.example.com ${publicKey}`],
    ['negated host', `!example.com ${publicKey}`],
    ['malformed hash', `|1|abc|def ${publicKey}`]
  ];
  for (const [name, source] of unsupported) assert.throws(() => parseKnownHosts(source), { code: 'CONFIG_INVALID' }, name);
});
test('malformed known_hosts records never become trusted keys', () => {
  for (const source of ['x invalid-key AAAA', 'x ssh-rsa !!!', 'x']) assert.throws(() => parseKnownHosts(source), { code: 'CONFIG_INVALID' });
});
test('ECDSA and Ed25519 public host keys are parsed', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'sec1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const ec = ssh2.utils.parseKey(privateKey);
  const ecRecords = parseKnownHosts(`host ${ec.type} ${ec.getPublicSSH().toString('base64')}`);
  assert.equal(createVerifier(ecRecords, 'host', 22)(ec.getPublicSSH()), true);
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const string = (bytes) => { const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); return Buffer.concat([size, bytes]); };
  const blob = Buffer.concat([string(Buffer.from('ssh-ed25519')), string(raw)]);
  assert.equal(createVerifier(parseKnownHosts(`host ssh-ed25519 ${blob.toString('base64')}`), 'host', 22)(blob), true);
});
