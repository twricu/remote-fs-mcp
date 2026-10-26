import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';

let cachedKey;
export function testKey() {
  if (!cachedKey) {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    const parsed = ssh2.utils.parseKey(privateKey);
    cachedKey = { pem: privateKey, parsed, blob: parsed.getPublicSSH() };
  }
  return cachedKey;
}
