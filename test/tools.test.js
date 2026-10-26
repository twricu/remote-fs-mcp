import test from 'node:test';
import assert from 'node:assert/strict';
import { mockService, params, tree } from './helpers/mock.js';
import { TOOL } from '../src/common/constants.js';

test('list_mounts is offline, bounded and contains only public identifiers', async () => {
  const fixture = mockService();
  const result = await fixture.service.run(TOOL.MOUNTS, {});
  assert.deepEqual(result.data.mounts, [{ serverId: 'test', mountId: 'logs', permissions: ['read'] }]);
  assert.equal(fixture.connectionCount(), 0);
  assert.equal((await fixture.service.run(TOOL.MOUNTS, { host: 'other' })).error.code, 'INVALID_ARGUMENT');
});
test('shared authorization rejects unconfigured targets and host overrides before connection', async () => {
  const fixture = mockService();
  for (const [change, code] of [[{ serverId: 'other' }, 'SERVER_NOT_FOUND'], [{ mountId: 'other' }, 'MOUNT_NOT_FOUND'], [{ host: 'evil' }, 'INVALID_ARGUMENT']]) {
    assert.equal((await fixture.service.run(TOOL.READ, { ...params(), ...change })).error.code, code);
  }
  assert.equal(fixture.connectionCount(), 0);
});
test('read permission covers directory, metadata, content, tail and search', async () => {
  const requirements = [TOOL.DIRECTORY, TOOL.STAT, TOOL.READ, TOOL.TAIL, TOOL.SEARCH];
  for (const tool of requirements) {
    const args = params('a.txt');
    if (tool === TOOL.DIRECTORY || tool === TOOL.SEARCH) args.path = '.';
    if (tool === TOOL.SEARCH) args.keyword = 'x';
    const fixture = mockService({ permissions: ['write', 'delete'] });
    assert.equal((await fixture.service.run(tool, args)).error.code, 'PERMISSION_DENIED', tool);
    assert.equal(fixture.connectionCount(), 0);
    const allowed = mockService({ permissions: ['read'] });
    assert.equal((await allowed.service.run(tool, args)).ok, true, tool);
  }
});
test('unsafe relative paths are rejected before any connection', async () => {
  const fixture = mockService();
  for (const value of ['../secret', '/etc/passwd', 'sub/../../x', 'a\\b', 'a\0b', '', 'sub//x', 'sub/./x', 'sub/', 'a'.repeat(4097)]) {
    const result = await fixture.service.run(TOOL.STAT, params(value));
    assert.equal(result.ok, false, JSON.stringify(value));
  }
  assert.equal(fixture.connectionCount(), 0);
});
test('mount ancestors, intermediate and target symlinks all fail', async () => {
  for (const location of ['/mnt', '/mnt/logs', '/mnt/logs/sub', '/mnt/logs/sub/deep.txt']) {
    const fixture = mockService();
    fixture.nodes.set(location, { type: 'symlink' });
    assert.equal((await fixture.service.run(TOOL.READ, params('sub/deep.txt'))).error.code, 'SYMLINK_DENIED');
    assert.equal(fixture.calls.some((call) => call.method === 'open'), false);
  }
});
test('deep ordinary paths are allowed without an artificial 64-segment cap', async () => {
  const fixture = mockService();
  const parts = [];
  for (let index = 0; index < 80; index++) {
    parts.push('d' + index);
    fixture.nodes.set('/mnt/logs/' + parts.join('/'), { type: 'directory' });
  }
  fixture.nodes.set('/mnt/logs/' + parts.join('/') + '/file', { type: 'file', content: Buffer.from('ok') });
  assert.equal((await fixture.service.run(TOOL.READ, params(parts.join('/') + '/file'))).data.content, 'ok');
});
test('list_directory skips links and special files and releases handles', async () => {
  const fixture = mockService();
  const result = await fixture.service.run(TOOL.DIRECTORY, params());
  assert.equal(result.ok, true);
  assert.equal(result.data.entries.some((entry) => ['link', 'pipe'].includes(entry.name)), false);
  assert.equal(result.meta.skipped.symlink, 1);
  assert.equal(fixture.channels[0].handles.size, 0);
  assert.ok(fixture.calls.filter((call) => call.method === 'readdir').length > 1);
});
test('directory limit, empty directory, exact boundary and invalid limits', async () => {
  const fixture = mockService();
  const limited = await fixture.service.run(TOOL.DIRECTORY, { ...params(), limit: 1 });
  assert.equal(limited.data.entries.length, 1);
  assert.equal(limited.meta.truncated, true);
  const exact = await fixture.service.run(TOOL.DIRECTORY, { ...params('sub'), limit: 1 });
  assert.equal(exact.meta.truncated, false);
  fixture.nodes.set('/mnt/logs/new', { type: 'directory' });
  assert.deepEqual((await fixture.service.run(TOOL.DIRECTORY, params('new'))).data.entries, []);
  for (const limit of [0, 10001, 1.5]) assert.equal((await fixture.service.run(TOOL.DIRECTORY, { ...params(), limit })).error.code, 'INVALID_ARGUMENT');
});
test('large directories can be listed and paged without losing valid entries', async () => {
  const fixture = mockService();
  for (let index = 0; index < 350; index++) fixture.nodes.set('/mnt/logs/file-' + index, { type: 'file', content: Buffer.alloc(0) });
  const all = await fixture.service.run(TOOL.DIRECTORY, { ...params(), limit: 500 });
  assert.equal(all.meta.truncated, false);
  assert.equal(all.data.entries.length, 355);
  let offset = 0;
  const collected = [];
  for (let page = 0; page < 10; page++) {
    const result = await fixture.service.run(TOOL.DIRECTORY, { ...params(), offset, limit: 100 });
    collected.push(...result.data.entries.map((entry) => entry.path));
    if (result.data.nextOffset === null) break;
    assert.ok(result.data.nextOffset > offset);
    offset = result.data.nextOffset;
  }
  assert.deepEqual(collected.sort(), all.data.entries.map((entry) => entry.path).sort());
});
test('stat handles directories and zero-sized files; rejects missing, denied and unsafe targets', async () => {
  const fixture = mockService();
  fixture.nodes.set('/mnt/logs/denied', { type: 'file', denied: true });
  assert.equal((await fixture.service.run(TOOL.STAT, params())).data.type, 'directory');
  assert.equal((await fixture.service.run(TOOL.STAT, params('empty'))).data.size, 0);
  for (const [file, code] of [['missing', 'NOT_FOUND'], ['denied', 'PERMISSION_DENIED'], ['link', 'SYMLINK_DENIED'], ['pipe', 'NOT_REGULAR_FILE']]) assert.equal((await fixture.service.run(TOOL.STAT, params(file))).error.code, code);
});
test('read_file supports UTF-8 chunks, byte offsets and EOF', async () => {
  const fixture = mockService();
  const first = await fixture.service.run(TOOL.READ, { ...params('unicode'), maxBytes: 7 });
  assert.equal(first.data.content, '中文');
  assert.equal(first.data.nextOffset, 6);
  const next = await fixture.service.run(TOOL.READ, { ...params('unicode'), offset: 6, maxBytes: 4 });
  assert.equal(next.data.content, '😀');
  for (const file of ['empty', 'a.txt']) {
    const eof = await fixture.service.run(TOOL.READ, { ...params(file), offset: 100000 });
    assert.equal(eof.data.eof, true); assert.equal(eof.data.content, '');
  }
  assert.equal((await fixture.service.run(TOOL.READ, { ...params('unicode'), offset: 1 })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await fixture.service.run(TOOL.READ, { ...params('unicode'), maxBytes: 1 })).error.code, 'INVALID_ARGUMENT');
});
test('large files use 1 MiB default reads, allow 4 MiB requests and resume beyond that range', async () => {
  const fixture = mockService();
  fixture.nodes.set('/mnt/logs/large', { type: 'file', content: Buffer.alloc(4194341, 97) });
  const initial = await fixture.service.run(TOOL.READ, params('large'));
  assert.equal(initial.data.bytesReturned, 1048576);
  assert.equal(initial.data.nextOffset, 1048576);
  assert.equal(initial.meta.truncated, true);
  const full = await fixture.service.run(TOOL.READ, { ...params('large'), maxBytes: 4194304 });
  assert.equal(full.data.content.length, 4194304);
  assert.equal(full.data.nextOffset, 4194304);
  const remaining = await fixture.service.run(TOOL.READ, { ...params('large'), offset: full.data.nextOffset });
  assert.equal(remaining.data.content, 'a'.repeat(37));
  assert.equal(remaining.data.eof, true);
  assert.equal(remaining.meta.truncated, false);
});
test('read rejects binary, invalid UTF-8, directories and excessive arguments', async () => {
  const fixture = mockService();
  fixture.nodes.set('/mnt/logs/bad', { type: 'file', content: Buffer.from([0xff]) });
  for (const file of ['binary', 'bad']) assert.equal((await fixture.service.run(TOOL.READ, params(file))).error.code, 'UNSUPPORTED_CONTENT');
  assert.equal((await fixture.service.run(TOOL.READ, params())).error.code, 'NOT_REGULAR_FILE');
  for (const change of [{ maxBytes: 4194305 }, { offset: -1 }, { offset: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal((await fixture.service.run(TOOL.READ, { ...params('a.txt'), ...change })).error.code, 'INVALID_ARGUMENT');
});
test('tail LF/CRLF, no final newline, empty file and bounded huge line', async () => {
  const fixture = mockService({ security: { maxReadBytes: 262144 } });
  assert.equal((await fixture.service.run(TOOL.TAIL, { ...params('a.txt'), lines: 2 })).data.content, 'Hello world\nlast\n');
  assert.equal((await fixture.service.run(TOOL.TAIL, params('unicode'))).data.content, '中文😀hello\n第二行\n');
  assert.equal((await fixture.service.run(TOOL.TAIL, params('empty'))).data.linesReturned, 0);
  fixture.nodes.set('/mnt/logs/no-newline', { type: 'file', content: Buffer.from('a\nb') });
  assert.equal((await fixture.service.run(TOOL.TAIL, { ...params('no-newline'), lines: 1 })).data.content, 'b');
  fixture.nodes.set('/mnt/logs/huge', { type: 'file', content: Buffer.alloc(300000, 65) });
  const huge = await fixture.service.run(TOOL.TAIL, params('huge'));
  assert.equal(huge.meta.bytesRead, 262144); assert.equal(huge.meta.truncated, true);
  for (const lines of [0, 100001]) assert.equal((await fixture.service.run(TOOL.TAIL, { ...params('a.txt'), lines })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await fixture.service.run(TOOL.TAIL, params('binary'))).error.code, 'UNSUPPORTED_CONTENT');
});
test('search literal/case/depth, line numbers, binary skip and match limits', async () => {
  const fixture = mockService();
  const result = await fixture.service.run(TOOL.SEARCH, { ...params(), keyword: 'Hello' });
  assert.equal(result.ok, true);
  assert.equal(result.data.matches.length, 2);
  assert.equal(result.data.matches.find((match) => match.path === 'a.txt').line, 2);
  assert.equal(result.meta.skipped.binary, 1);
  const shallow = await fixture.service.run(TOOL.SEARCH, { ...params(), keyword: 'Hello', maxDepth: 0 });
  assert.equal(shallow.data.matches.length, 1); assert.equal(shallow.meta.truncated, true);
  const insensitive = await fixture.service.run(TOOL.SEARCH, { ...params(), keyword: 'hello', caseSensitive: false });
  assert.equal(insensitive.data.matches.length, 3);
  const limited = await fixture.service.run(TOOL.SEARCH, { ...params(), keyword: 'Hello', maxResults: 1 });
  assert.equal(limited.data.matches.length, 1); assert.equal(limited.meta.truncated, true);
  assert.equal((await fixture.service.run(TOOL.SEARCH, { ...params(), keyword: '.*' })).data.matches.length, 0);
});
test('search has strict arguments and no match is valid', async () => {
  const fixture = mockService();
  for (const change of [{ keyword: '' }, { keyword: 'a\nb' }, { maxDepth: 17 }, { maxResults: 1001 }]) assert.equal((await fixture.service.run(TOOL.SEARCH, { ...params(), keyword: 'x', ...change })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await fixture.service.run(TOOL.SEARCH, { ...params(), keyword: 'not-present' })).data.matches.length, 0);
});
test('search scans beyond response byte limits and earlier small total budgets', async () => {
  const nodes = new Map([['/', { type: 'directory' }], ['/mnt', { type: 'directory' }], ['/mnt/logs', { type: 'directory' }]]);
  const line = `${'a'.repeat(1023)}\n`;
  nodes.set('/mnt/logs/0.log', { type: 'file', content: Buffer.from(`${line.repeat(5120)}late-marker\n`) });
  for (const name of ['1.log', '2.log']) nodes.set(`/mnt/logs/${name}`, { type: 'file', content: Buffer.from(line.repeat(3072)) });
  nodes.set('/mnt/logs/3.log', { type: 'file', content: Buffer.from(`${line.repeat(2048)}late-marker\n${line.repeat(1024)}`) });
  const fixture = mockService({ nodes });
  const result = await fixture.service.run(TOOL.SEARCH, { ...params(), keyword: 'late-marker' });
  assert.deepEqual(result.data.matches, [{ path: '0.log', line: 5121, context: 'late-marker' }, { path: '3.log', line: 2049, context: 'late-marker' }]);
  assert.equal(result.meta.bytesRead, 14680088);
  assert.equal(result.meta.filesScanned, 4);
  assert.equal(result.meta.reasons.includes('read_limit'), false);
  assert.equal(result.meta.reasons.includes('scan_bytes_limit'), false);
});
test('search bounds bytes, long lines, empty files and block-spanning matches', async () => {
  const nodes = tree();
  for (const file of [...nodes.keys()]) if (file.startsWith('/mnt/logs/')) nodes.delete(file);
  nodes.set('/mnt/logs/one', { type: 'file', content: Buffer.from(`${'a'.repeat(32765)}needle\n`) });
  const fixture = mockService({ nodes, security: { maxLineBytes: 65536 } });
  assert.equal((await fixture.service.run(TOOL.SEARCH, { ...params(), keyword: 'needle' })).data.matches.length, 1);
  nodes.set('/mnt/logs/one', { type: 'file', content: Buffer.from(`${'a'.repeat(70000)}\nneedle\n`) });
  const long = await fixture.service.run(TOOL.SEARCH, { ...params(), keyword: 'needle' });
  assert.equal(long.data.matches[0].line, 2); assert.equal(long.meta.skipped.longLine, 1);
  const tiny = mockService({ nodes, security: { maxScanBytes: 10, maxReadBytes: 5, maxSearchDepth: 0, maxSearchResults: 1 } });
  const scan = await tiny.service.run(TOOL.SEARCH, { ...params(), keyword: 'x' });
  assert.ok(scan.meta.bytesRead <= 10); assert.equal(scan.meta.truncated, true);
  assert.equal((await tiny.service.run(TOOL.READ, params('one'))).meta.bytesRead, 5);
});
test('timeout closes its channel and allows subsequent operations', async () => {
  const fixture = mockService({ security: { operationTimeoutMs: 20 }, channelOptions: { hang: 'read' } });
  assert.equal((await fixture.service.run(TOOL.READ, params('a.txt'))).error.code, 'TIMEOUT');
  assert.equal(fixture.channels[0].destroyed, true);
  assert.equal((await fixture.service.run(TOOL.STAT, params('a.txt'))).ok, true);
});
