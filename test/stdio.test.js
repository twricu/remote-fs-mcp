import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loopback } from './helpers/loopback.js';
import { params } from './helpers/mock.js';
import { gzipSync } from 'node:zlib';

const entry = path.resolve('src/index.js');
test('SDK stdio discovers twelve scoped tools, marks mutations and enforces default read-only access', { timeout: 20000 }, async (t) => {
  const fixture = await loopback(t);
  const file = await fixture.writeConfig();
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--config', file], stderr: 'pipe', env: {} });
  let logs = '';
  transport.stderr.on('data', (bytes) => { logs += bytes.toString(); });
  const client = new Client({ name: 'local-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 12);
  assert.equal(tools.filter((tool) => tool.annotations.readOnlyHint === true).length, 7);
  assert.equal(tools.find((tool) => tool.name === 'delete_path').annotations.destructiveHint, true);
  assert.equal(tools.find((tool) => tool.name === 'create_directory').annotations.destructiveHint, false);
  const mounts = await client.callTool({ name: 'list_mounts', arguments: {} });
  assert.equal(mounts.structuredContent.ok, true);
  assert.equal(fixture.connectionCount(), 0);
  for (const [name, args] of [['list_directory', params()], ['stat_file', params('a.txt')], ['read_file', params('a.txt')], ['tail_file', params('a.txt')], ['search_files', { ...params(), keyword: 'Hello' }]]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.structuredContent.ok, true, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
  fixture.nodes.set('/mnt/logs/a.gz', { type: 'file', content: gzipSync(Buffer.from('archive text\n')) });
  assert.equal((await client.callTool({ name: 'read_archive', arguments: { ...params('a.gz'), mode: 'read' } })).structuredContent.data.content, 'archive text\n');
  const mutation = await client.callTool({ name: 'write_file', arguments: { ...params('new'), content: 'x' } });
  assert.equal(mutation.structuredContent.error.code, 'PERMISSION_DENIED');
  assert.equal(fixture.nodes.has('/mnt/logs/new'), false);
  fixture.nodes.set('/mnt/logs/large', { type: 'file', content: Buffer.alloc(4194304, 97) });
  const large = await client.callTool({ name: 'read_file', arguments: { ...params('large'), maxBytes: 4194304 } });
  assert.equal(large.structuredContent.ok, true);
  assert.equal(large.structuredContent.data.bytesReturned, 4194304);
  assert.equal(JSON.parse(large.content[0].text).data.content.length, 4194304);
  const denied = await client.callTool({ name: 'read_file', arguments: params('../secret') });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, 'PATH_OUT_OF_SCOPE');
  assert.equal(logs.includes(fixture.password), false);
  assert.equal(logs.includes('Hello world'), false);
  assert.equal(logs.includes('BEGIN RSA'), false);
});
test('real stdio/SFTP supports opted-in writes, append, rename, extraction and recursive deletion', { timeout: 20000 }, async (t) => {
  const fixture = await loopback(t);
  const config = await fixture.writeConfig(undefined, 'mutable.yaml', ['read', 'write', 'delete']);
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--config', config], stderr: 'pipe', env: {} });
  transport.stderr.resume();
  const client = new Client({ name: 'mutation-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const call = async (name, args) => {
    const result = (await client.callTool({ name, arguments: args })).structuredContent;
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  await call('create_directory', { ...params('scratch/sub'), recursive: true });
  await call('write_file', { ...params('scratch/sub/file'), content: 'one' });
  await call('write_file', { ...params('scratch/sub/file'), content: 'two', mode: 'append' });
  assert.equal((await call('read_file', params('scratch/sub/file'))).data.content, 'onetwo');
  await call('write_file', { ...params('scratch/sub/file'), content: 'new', mode: 'overwrite' });
  await call('move_path', { ...params('scratch/sub/file'), destinationPath: 'scratch/sub/renamed' });
  assert.equal((await call('read_file', params('scratch/sub/renamed'))).data.content, 'new');
  fixture.nodes.set('/mnt/logs/source.gz', { type: 'file', content: gzipSync(Buffer.from('archived\n')) });
  await call('extract_archive', { ...params('source.gz'), destinationPath: 'scratch/extracted' });
  assert.equal((await call('read_file', params('scratch/extracted/source'))).data.content, 'archived\n');
  await call('delete_path', { ...params('scratch'), recursive: true });
  assert.equal([...fixture.nodes.keys()].some((name) => name.startsWith('/mnt/logs/scratch')), false);
  assert.equal(fixture.nodes.has('/mnt/logs/a.txt'), true);
});
test('CLI handles help and rejects invalid options without polluting stdout or exposing inputs', { timeout: 10000 }, async () => {
  const cases = [
    [['--help'], 0], [['--version'], 0], [['--config', '/missing/local/config.yaml'], 1],
    [['--password', 'do-not-print-this'], 1], [['--config'], 1],
    [['--config', 'one', '--config', 'two'], 1], [['--help', '--config', 'one'], 1]
  ];
  for (const [args, expectedCode] of cases) {
    const child = spawn(process.execPath, [entry, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (bytes) => { stdout += bytes; });
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    child.stdin.end();
    const [code] = await once(child, 'close');
    assert.equal(stdout, '');
    assert.equal(stderr.includes('do-not-print-this'), false);
    assert.equal(code, expectedCode, args.join(' '));
    if (expectedCode !== 0) assert.match(stderr, /CONFIG_INVALID/u);
    else if (args[0] === '--help') assert.match(stderr, /Usage:/u);
    else assert.match(stderr, /remote-fs-mcp \d+\.\d+\.\d+/u);
  }
});

test('2025 legacy stdio handshake and EOF shutdown are supported', { timeout: 10000 }, async (t) => {
  const fixture = await loopback(t);
  const file = await fixture.writeConfig();
  const child = spawn(process.execPath, [entry, '--config', file], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } } });
  const initialized = JSON.parse((await lines.next()).value);
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list', params: {} });
  assert.equal(JSON.parse((await lines.next()).value).result.tools.length, 12);
  assert.equal(fixture.connectionCount(), 0);
  send({ id: 3, method: 'tools/call', params: { name: 'read_file', arguments: params('a.txt') } });
  const read = JSON.parse((await lines.next()).value).result;
  assert.equal(read.structuredContent.ok, true);
  assert.equal(read.structuredContent.data.content, 'first\nHello world\nlast\n');
  const exited = once(child, 'exit');
  child.stdin.end();
  assert.equal((await exited)[0], 0);
  assert.equal(fixture.connectionCount(), 1);
});

test('MCP cancellation aborts actual pending SFTP I/O and keeps other calls usable', { timeout: 10000 }, async (t) => {
  const fixture = await loopback(t);
  fixture.nodes.get('/mnt/logs/a.txt').hangRead = true;
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--config', await fixture.writeConfig()], stderr: 'pipe', env: {} });
  let logs = '';
  transport.stderr.on('data', (bytes) => { logs += bytes; });
  const client = new Client({ name: 'cancellation-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const controller = new AbortController();
  const pending = client.callTool({ name: 'read_file', arguments: params('a.txt') }, { signal: controller.signal });
  // Observe the test server, rather than guessing how long a handshake takes.
  const deadline = performance.now() + 3000;
  while (!fixture.calls.some((call) => call.method === 'hanging-read') && performance.now() < deadline) await delay(10);
  assert.ok(fixture.calls.some((call) => call.method === 'hanging-read'));
  const rejected = assert.rejects(pending);
  controller.abort();
  await rejected;
  while (!logs.includes('CANCELLED') && performance.now() < deadline) await delay(10);
  assert.ok(logs.includes('CANCELLED'));
  assert.equal((await client.callTool({ name: 'stat_file', arguments: params('empty') })).structuredContent.ok, true);
  assert.equal(fixture.connectionCount(), 1);
});
