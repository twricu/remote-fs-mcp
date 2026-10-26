import ssh2 from 'ssh2';
import { CODE, fail } from '../common/errors.js';
import { LIMIT } from '../common/constants.js';
import { localPath, readBounded } from '../config/files.js';

function credential(auth, direct, variable, env) {
  let value = auth[direct];
  if (auth[variable] !== undefined) value = env[auth[variable]];
  if (typeof value !== 'string' || value.length === 0 || value.length > 65536) fail(CODE.CONFIG_INVALID, 'auth.credential');
  return value;
}
async function identity(file, passphrase, base, home) {
  const bytes = await readBounded(localPath(file, base, home), LIMIT.KEY, 'auth.privateKeyPath');
  const key = ssh2.utils.parseKey(bytes, passphrase);
  if (key instanceof Error || !key.isPrivateKey()) fail(CODE.AUTH_FAILED);
  return { type: 'publickey', key, passphrase };
}
export async function prepareAuth(auth, ssh, { env, base, home }) {
  const methods = [];
  if (auth.type === 'password') {
    methods.push({ type: 'password', password: credential(auth, 'password', 'passwordEnv', env) });
  } else if (auth.type === 'private-key') {
    let passphrase;
    if (auth.passphrase !== undefined || auth.passphraseEnv !== undefined) passphrase = credential(auth, 'passphrase', 'passphraseEnv', env);
    methods.push(await identity(auth.privateKeyPath, passphrase, base, home));
  } else {
    let endpoint = env.SSH_AUTH_SOCK;
    if (ssh.identityagent === 'none') endpoint = undefined;
    else if (ssh.identityagent && ssh.identityagent !== 'SSH_AUTH_SOCK') endpoint = localPath(ssh.identityagent, base, home);
    if (endpoint) {
      if (typeof endpoint !== 'string' || endpoint.length > LIMIT.PATH_BYTES || endpoint.includes('\0')) fail(CODE.CONFIG_INVALID, 'auth.agent');
      methods.push({ type: 'agent', agent: endpoint });
    }
    if (auth.type === 'auto') {
      for (const file of ssh.identities) methods.push(await identity(file, undefined, base, home));
    }
  }
  if (methods.length === 0) fail(CODE.AUTH_FAILED);
  return methods;
}
