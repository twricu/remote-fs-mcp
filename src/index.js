#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config/load.js';
import { VERSION, LIMIT } from './common/constants.js';
import { CODE, fail, errorResult } from './common/errors.js';
import { audit } from './security/audit.js';
import { FileService } from './tools/service.js';
import { createServer } from './tools/register.js';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--config') {
      if (options.config !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) fail(CODE.CONFIG_INVALID, 'cli');
      options.config = argv[++index];
    } else if (arg === '--help' || arg === '--version') {
      if (argv.length !== 1) fail(CODE.CONFIG_INVALID, 'cli');
      options.mode = arg;
    } else fail(CODE.CONFIG_INVALID, 'cli');
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode) {
    let message = `remote-fs-mcp ${VERSION}\n`;
    if (options.mode === '--help') message += 'Usage: remote-fs-mcp [--config /absolute/path/config.yaml]\nDefault: ~/.remote-fs-mcp/config.yaml\nMount-scoped SSH/SFTP over MCP stdio. Read-only by default; write/delete are opt-in.\n';
    process.stderr.write(message);
  } else {
    const config = await loadConfig(options.config);
    for (const server of config.servers.values()) { if (server.username === 'root') audit('root_account', { serverId: server.id }); }
    const service = new FileService(config);
    const transport = serveStdio(() => createServer(service), { onerror: () => audit('protocol_error', { code: CODE.REMOTE_ERROR }) });
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      service.close();
      const timer = setTimeout(() => process.exit(0), LIMIT.EXIT_MS);
      timer.unref();
      Promise.resolve(transport.close()).catch(() => {});
    };
    process.stdin.once('end', close);
    process.stdin.once('close', close);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }
} catch (error) {
  const result = errorResult(error);
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 1;
}
