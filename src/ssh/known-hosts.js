import { createHmac, timingSafeEqual } from 'node:crypto';
import ssh2 from 'ssh2';
import { CODE, fail } from '../common/errors.js';

const KEY_TYPES = new Set(['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521']);
function decode(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) fail(CODE.CONFIG_INVALID, 'knownHosts.encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) fail(CODE.CONFIG_INVALID, 'knownHosts.encoding');
  return bytes;
}
function equal(a, b) { return a.length === b.length && timingSafeEqual(a, b); }
export function parseKnownHosts(source) {
  const records = [];
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    try {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const fields = line.split(/\s+/u);
      let revoked = false;
      if (fields[0].startsWith('@')) {
        if (fields.shift() !== '@revoked') fail(CODE.CONFIG_INVALID, 'knownHosts.marker');
        revoked = true;
      }
      if (fields.length < 3) fail(CODE.CONFIG_INVALID, 'knownHosts.record');
      const [names, type, encoded] = fields;
      if (!KEY_TYPES.has(type)) fail(CODE.CONFIG_INVALID, 'knownHosts.keyType');
      const key = decode(encoded);
      const parsed = ssh2.utils.parseKey(`${type} ${encoded}`);
      if (parsed instanceof Error || parsed.type !== type || !equal(parsed.getPublicSSH(), key)) fail(CODE.CONFIG_INVALID, 'knownHosts.key');
      let match;
      if (names.startsWith('|')) {
        const parts = names.split('|');
        if (parts.length !== 4 || parts[1] !== '1') fail(CODE.CONFIG_INVALID, 'knownHosts.hash');
        const salt = decode(parts[2]);
        const digest = decode(parts[3]);
        if (salt.length !== 20 || digest.length !== 20) fail(CODE.CONFIG_INVALID, 'knownHosts.hash');
        match = (host) => equal(createHmac('sha1', salt).update(host).digest(), digest);
      } else {
        const patterns = names.split(',');
        for (const name of patterns) {
          if (revoked && name === '*') continue;
          if (!name || /[*!?\\\0]/u.test(name)) fail(CODE.CONFIG_INVALID, 'knownHosts.pattern');
        }
        match = (host) => patterns.some((name) => (revoked && name === '*') || name.toLowerCase() === host.toLowerCase());
      }
      records.push({ key, revoked, match });
    } catch (_error) { fail(CODE.CONFIG_INVALID, `knownHosts line ${index + 1}`); }
  }
  return records;
}
export function createVerifier(records, host, port) {
  let identity = host;
  if (port !== 22) identity = `[${host}]:${port}`;
  return (key) => {
    if (!Buffer.isBuffer(key)) return false;
    const matches = records.filter((record) => record.match(identity));
    if (matches.some((record) => record.revoked && equal(record.key, key))) return false;
    return matches.some((record) => !record.revoked && equal(record.key, key));
  };
}
