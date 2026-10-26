import path from 'node:path';
import os from 'node:os';
import { stat } from 'node:fs/promises';
import { parseAllDocuments, visit, isAlias, LineCounter } from 'yaml';
import { CODE, fail, FsError } from '../common/errors.js';
import { LIMIT } from '../common/constants.js';
import { validateMount } from '../security/path-policy.js';
import { parseSshConfig } from '../ssh/ssh-config.js';
import { parseKnownHosts, createVerifier } from '../ssh/known-hosts.js';
import { prepareAuth } from '../ssh/auth.js';
import { configSchema, hostSchema } from './validate.js';
import { readBounded, localPath, localText } from './files.js';

export function parseConfig(source) {
  try {
    const lineCounter = new LineCounter();
    const documents = parseAllDocuments(source, { version: '1.2', uniqueKeys: true, prettyErrors: false, logLevel: 'silent', customTags: [], lineCounter });
    if (documents.length !== 1) fail(CODE.CONFIG_INVALID, 'yaml.documents');
    const doc = documents[0];
    if (doc.errors.length || doc.warnings.length) {
      const issue = doc.errors[0] ?? doc.warnings[0];
      const position = lineCounter.linePos(issue.pos?.[0] ?? 0);
      fail(CODE.CONFIG_INVALID, `yaml line ${position.line}, column ${position.col}`);
    }
    visit(doc, (_, node) => { if (isAlias(node) || node?.tag) fail(CODE.CONFIG_INVALID, 'yaml.aliasOrTag'); });
    const parsed = configSchema.safeParse(doc.toJS({ maxAliasCount: 0 }));
    if (!parsed.success) {
      // Strict objects contain only declared keys; never include issue messages,
      // unknown-key names, input values or the original YAML in diagnostics.
      const location = parsed.error.issues[0].path.map((part) => String(part)).join('.').slice(0, 256);
      fail(CODE.CONFIG_INVALID, `schema:${location}`);
    }
    const config = parsed.data;
    const servers = new Set();
    for (const server of config.servers) {
      if (servers.has(server.id)) fail(CODE.CONFIG_INVALID, 'server.id');
      servers.add(server.id);
      const mounts = new Set();
      for (const mount of server.mounts) {
        if (mounts.has(mount.id)) fail(CODE.CONFIG_INVALID, 'mount.id');
        mounts.add(mount.id);
        validateMount(mount.path);
      }
    }
    return config;
  } catch (error) {
    if (error instanceof FsError) throw error;
    fail(CODE.CONFIG_INVALID, 'configuration');
  }
}
export async function loadConfig(configFile, { env = process.env, home = os.homedir(), cwd = process.cwd() } = {}) {
  let selected = configFile;
  if (selected === undefined) selected = env.REMOTE_FS_MCP_CONFIG;
  if (selected === undefined) selected = '~/.remote-fs-mcp/config.yaml';
  const file = localPath(selected, cwd, home);
  const base = path.dirname(file);
  const config = parseConfig(localText(await readBounded(file, LIMIT.CONFIG, 'configFile'), 'configFile.encoding'));
  const servers = new Map();
  for (const server of config.servers) {
    const connection = server.connection;
    let ssh = { identities: [] };
    if (connection.auth.type === 'auto') {
      const sshFile = path.join(home, '.ssh', 'config');
      let present = true;
      try { await stat(sshFile); } catch (error) {
        if (error.code === 'ENOENT') present = false;
        else fail(CODE.CONFIG_INVALID, 'sshConfig');
      }
      if (present) ssh = parseSshConfig(localText(await readBounded(sshFile, LIMIT.SSH_CONFIG, 'sshConfig'), 'sshConfig.encoding'), connection.host);
    }
    const host = ssh.hostname ?? connection.host;
    const username = connection.username ?? ssh.user;
    let port = connection.port;
    if (port === undefined && ssh.port !== undefined) {
      if (!/^\d+$/u.test(ssh.port)) fail(CODE.CONFIG_INVALID, 'sshConfig.port');
      port = Number(ssh.port);
    }
    if (port === undefined) port = 22;
    if (!hostSchema.safeParse(host).success || !username || !Number.isInteger(port) || port < 1 || port > 65535) fail(CODE.CONFIG_INVALID, 'connection');
    const records = parseKnownHosts(localText(await readBounded(localPath(connection.knownHostsFile, base, home), LIMIT.KNOWN_HOSTS, 'knownHostsFile'), 'knownHosts.encoding'));
    const methods = await prepareAuth(connection.auth, ssh, { env, base, home });
    servers.set(server.id, { id: server.id, host, port, username, methods, verifier: createVerifier(records, host, port), mounts: new Map(server.mounts.map((mount) => [mount.id, mount])) });
  }
  return { servers, security: config.security };
}
