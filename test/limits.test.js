import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mockService, params, tree, attrs } from './helpers/mock.js';
import { LIMIT } from '../src/common/constants.js';

test('queue is bounded; cancellation drains waiters without leaking slots', async () => {
  const fixture = mockService({ security: { maxConcurrentOperations: 1, operationTimeoutMs: 1000 }, channelOptions: { hang: 'read' } });
  const controller = new AbortController();
  const pending = Array.from({ length: LIMIT.QUEUE + 1 }, () => fixture.service.run('read_file', params('a.txt'), controller.signal));
  await nextTurn();
  assert.equal((await fixture.service.run('read_file', params('a.txt'))).error.code, 'LIMIT_EXCEEDED');
  controller.abort();
  const results = await Promise.all(pending);
  assert.ok(results.every((result) => result.error.code === 'CANCELLED'));
  assert.equal((await fixture.service.run('stat_file', params('a.txt'))).ok, true);
});
test('empty files respect a configurable traversal budget instead of a small file-count cap', async () => {
  const nodes = new Map([['/', { type: 'directory' }], ['/mnt', { type: 'directory' }], ['/mnt/logs', { type: 'directory' }]]);
  for (let directory = 0; directory < 2; directory++) {
    const parent = `/mnt/logs/d${directory}`;
    nodes.set(parent, { type: 'directory' });
    for (let index = 0; index < 600; index++) nodes.set(`${parent}/f${index}`, { type: 'file', content: Buffer.alloc(0) });
  }
  const fixture = mockService({ nodes, security: { maxOperationEntries: 1000 } });
  const result = await fixture.service.run('search_files', { ...params(), keyword: 'x' });
  assert.equal(result.ok, true);
  assert.ok(result.meta.filesScanned > 900 && result.meta.filesScanned < 1000);
  assert.ok(result.meta.reasons.includes('entry_limit'));
  assert.equal(result.meta.bytesRead, 0);
  fixture.config.security.maxOperationEntries = 2000;
  const all = await fixture.service.run('search_files', { ...params(), keyword: 'x' });
  assert.equal(all.meta.filesScanned, 1200);
  assert.equal(all.meta.truncated, false);
});
test('global scan entry cap also counts skipped special files', async () => {
  const nodes = new Map([['/', { type: 'directory' }], ['/mnt', { type: 'directory' }], ['/mnt/logs', { type: 'directory' }]]);
  for (let directory = 0; directory < 18; directory++) {
    const parent = `/mnt/logs/d${directory}`;
    nodes.set(parent, { type: 'directory' });
    for (let index = 0; index < 600; index++) nodes.set(`${parent}/p${index}`, { type: 'fifo' });
  }
  const fixture = mockService({ nodes, security: { maxOperationEntries: 1000 } });
  const result = await fixture.service.run('search_files', { ...params(), keyword: 'x' });
  assert.equal(result.ok, true);
  assert.ok(result.meta.entriesScanned <= 1001);
  assert.equal(result.meta.filesScanned, 0);
  assert.ok(result.meta.reasons.includes('entry_limit'));
});
test('serialized result cap counts escaping and both response representations', async () => {
  const fixture = mockService({ security: { maxReadBytes: 6291456 } });
  fixture.nodes.set('/mnt/logs/control', { type: 'file', content: Buffer.alloc(6291456, 1) });
  const result = await fixture.service.run('read_file', { ...params('control'), maxBytes: 6291456 });
  assert.equal(result.error.code, 'LIMIT_EXCEEDED');
});
test('fstat prevents reading a target replaced with a special file', async () => {
  const fixture = mockService();
  const original = fixture.service.open;
  fixture.service.open = async (...args) => {
    const io = await original(...args);
    io.channel.fstat = (_handle, callback) => queueMicrotask(() => callback(null, attrs({ type: 'fifo' })));
    return io;
  };
  assert.equal((await fixture.service.run('read_file', params('a.txt'))).error.code, 'NOT_REGULAR_FILE');
  assert.equal(fixture.calls.some((call) => call.method === 'read'), false);
});
test('tail of a large file reads only its ending range', async () => {
  const fixture = mockService();
  const content = Buffer.from('line\n'.repeat(300000));
  fixture.nodes.set('/mnt/logs/huge', { type: 'file', content });
  const result = await fixture.service.run('tail_file', { ...params('huge'), lines: 1 });
  assert.equal(result.data.content, 'line\n');
  const reads = fixture.calls.filter((call) => call.method === 'read');
  assert.ok(reads.length > 0);
  assert.ok(reads.every((call) => call.args[2] >= content.length - LIMIT.CHUNK));
});
test('untrusted enumeration names are skipped before any child access', async () => {
  const nodes = tree();
  for (const name of ['bad\\name', 'bad\0name', 'bad\uFFFDname']) nodes.set(`/mnt/logs/${name}`, { type: 'file', content: Buffer.from('x') });
  const fixture = mockService({ nodes });
  const result = await fixture.service.run('list_directory', params());
  assert.equal(result.meta.skipped.invalidName, 3);
  assert.equal(fixture.calls.some((call) => call.method === 'lstat' && /bad/u.test(call.args[0])), false);
});

test('late SFTP callback after cancellation cannot resume work or change result', { timeout: 2000 }, async () => {
  const fixture = mockService();
  const original = fixture.service.open;
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  let deliver;
  fixture.service.open = async (...args) => {
    const io = await original(...args);
    io.channel.read = (_handle, buffer, _offset, _length, position, callback) => {
      deliver = () => callback(null, 0, buffer, position);
      notifyStarted();
    };
    return io;
  };
  const controller = new AbortController();
  const pending = fixture.service.run('read_file', params('a.txt'), controller.signal);
  await started;
  controller.abort();
  const result = await pending;
  assert.equal(result.error.code, 'CANCELLED');
  const count = fixture.calls.length;
  deliver();
  await nextTurn();
  assert.equal(fixture.calls.length, count);
  assert.equal((await fixture.service.run('stat_file', params('a.txt'))).ok, true);
});

test('unexpected channel closure fails the operation and releases its slot', { timeout: 2000 }, async () => {
  const fixture = mockService({ channelOptions: { hang: 'read' } });
  const pending = fixture.service.run('read_file', params('a.txt'));
  while (!fixture.calls.some((call) => call.method === 'read')) await nextTurn();
  fixture.channels[0].destroy();
  assert.equal((await pending).error.code, 'REMOTE_ERROR');
  assert.equal((await fixture.service.run('stat_file', params('a.txt'))).ok, true);
});
