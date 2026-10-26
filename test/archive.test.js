import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mockService, params } from './helpers/mock.js';
import { tarBytes, zipBytes } from './helpers/archives.js';

const payload = [{ name: './logs/', type: 'directory', mode: 0o755 }, { name: './logs/app.log', content: 'first\n中文😀 needle\nlast\n' }];
function fixture(name, bytes, options = {}) {
  const result = mockService({ permissions: ['read', 'write'], ...options });
  result.nodes.set('/mnt/logs/' + name, { type: 'file', content: bytes });
  return result;
}

test('tar, tar.gz, zip and gzip support listing, UTF-8 reads, tail and safe extraction', async () => {
  const archives = [
    ['logs.tar', await tarBytes(payload)], ['logs.tgz', await tarBytes(payload, true)],
    ['logs.zip', await zipBytes(payload.map((entry) => ({ ...entry, name: entry.name.slice(2) })))],
    ['app.log.gz', gzipSync(Buffer.from(payload[1].content))]
  ];
  for (const [name, bytes] of archives) {
    const data = fixture(name, bytes);
    const listed = await data.service.run('read_archive', params(name));
    assert.equal(listed.ok, true, name);
    assert.ok(listed.data.entries.some((entry) => entry.type === 'file'));
    const read = await data.service.run('read_archive', { ...params(name), mode: 'read' });
    assert.equal(read.data.content, payload[1].content, name);
    const tail = await data.service.run('read_archive', { ...params(name), mode: 'tail', lines: 1 });
    assert.equal(tail.data.content, 'last\n');
    const extracted = await data.service.run('extract_archive', { ...params(name), destinationPath: 'out/deep' });
    assert.equal(extracted.ok, true, name);
    const target = '/mnt/logs/out/deep/' + read.data.entry;
    assert.equal(data.nodes.get(target).content.toString(), payload[1].content);
  }
});

test('archive reads paginate entries, require a selection for multiple files and honor byte boundaries', async () => {
  const data = fixture('logs.zip', await zipBytes([{ name: 'one', content: '中文😀x' }, { name: 'two', content: 'other' }]));
  const first = await data.service.run('read_archive', { ...params('logs.zip'), limit: 1 });
  assert.equal(first.data.nextOffset, 1);
  assert.equal(first.meta.truncated, true);
  assert.equal((await data.service.run('read_archive', { ...params('logs.zip'), offset: 1 })).data.entries[0].entry, 'two');
  assert.equal((await data.service.run('read_archive', { ...params('logs.zip'), mode: 'read' })).error.code, 'INVALID_ARGUMENT');
  const read = await data.service.run('read_archive', { ...params('logs.zip'), mode: 'read', entry: 'one', maxBytes: 7 });
  assert.equal(read.data.content, '中文');
  assert.equal(read.data.nextOffset, 6);
  assert.equal((await data.service.run('read_archive', { ...params('logs.zip'), mode: 'read', entry: 'one', offset: 1 })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await data.service.run('read_archive', { ...params('logs.zip'), mode: 'read', entry: 'missing' })).error.code, 'NOT_FOUND');
  assert.equal((await data.service.run('read_archive', { ...params('logs.zip'), mode: 'read', entry: '../outside' })).error.code, 'PATH_OUT_OF_SCOPE');
});

test('reading one ZIP member does not expand unrelated large members', async () => {
  const data = fixture('logs.zip', await zipBytes([{ name: 'small', content: 'ok' }, { name: 'large', content: 'x'.repeat(10000) }]), { security: { maxExtractBytes: 100 } });
  assert.equal((await data.service.run('read_archive', params('logs.zip'))).ok, true);
  assert.equal((await data.service.run('read_archive', { ...params('logs.zip'), mode: 'read', entry: 'small' })).data.content, 'ok');
  assert.equal((await data.service.run('extract_archive', { ...params('logs.zip'), destinationPath: 'out' })).error.code, 'LIMIT_EXCEEDED');
  assert.equal(data.nodes.has('/mnt/logs/out'), false);
});
test('tailing a large compressed log returns complete final lines without false truncation', async () => {
  const data = fixture('large.gz', gzipSync(Buffer.from('line\n'.repeat(900000))));
  const result = await data.service.run('read_archive', { ...params('large.gz'), mode: 'tail', lines: 1 });
  assert.equal(result.data.content, 'line\n');
  assert.equal(result.meta.truncated, false);
});

test('archive traversal, absolute paths, links and special entries never reach target writes', async () => {
  const unsafe = [
    { name: '../escape', content: 'x' }, { name: '/absolute', content: 'x' }, { name: 'C:/escape', content: 'x' },
    { name: 'bad\\name', content: 'x' }, { name: 'link', type: 'symlink', linkname: '../outside' },
    { name: 'link', type: 'link', linkname: 'outside' }, { name: 'pipe', type: 'fifo' }
  ];
  for (const entry of unsafe) {
    const data = fixture('unsafe.tar', await tarBytes([entry]));
    const result = await data.service.run('extract_archive', { ...params('unsafe.tar'), destinationPath: 'out' });
    assert.equal(result.error.code, 'INVALID_ARCHIVE', entry.name);
    assert.equal(data.calls.some((call) => ['mkdir', 'write', 'fsetstat'].includes(call.method)), false);
  }
  const zip = await zipBytes([{ name: 'safe007', content: 'x' }]);
  const broken = Buffer.from(zip);
  for (let offset = broken.indexOf('safe007'); offset >= 0; offset = broken.indexOf('safe007', offset + 7)) broken.write('../evil', offset);
  const data = fixture('unsafe.zip', broken);
  assert.equal((await data.service.run('extract_archive', { ...params('unsafe.zip'), destinationPath: 'out' })).error.code, 'INVALID_ARCHIVE');
  assert.equal(data.nodes.has('/mnt/logs/out'), false);
});

test('CRC corruption, duplicate targets and decompression bombs are rejected before mutation', async () => {
  const bytes = await zipBytes([{ name: 'a', content: 'data' }]);
  const corrupt = Buffer.from(bytes);
  const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  corrupt[central + 16] ^= 1;
  const bad = fixture('bad.zip', corrupt);
  assert.equal((await bad.service.run('extract_archive', { ...params('bad.zip'), destinationPath: 'out' })).error.code, 'INVALID_ARCHIVE');
  assert.equal(bad.nodes.has('/mnt/logs/out'), false);
  const duplicates = fixture('same.tar', await tarBytes([{ name: 'a', content: 'one' }, { name: 'a', content: 'two' }]));
  assert.equal((await duplicates.service.run('extract_archive', { ...params('same.tar'), destinationPath: 'out' })).error.code, 'INVALID_ARCHIVE');
  const bomb = fixture('large.gz', gzipSync(Buffer.alloc(100000)), { security: { maxExtractBytes: 1000 } });
  assert.equal((await bomb.service.run('extract_archive', { ...params('large.gz'), destinationPath: 'out' })).error.code, 'LIMIT_EXCEEDED');
  assert.equal(bomb.nodes.has('/mnt/logs/out'), false);
});

test('extraction checks separate source/destination permissions, collisions and target links', async () => {
  const data = fixture('logs.tar', await tarBytes([{ name: 'a', content: 'new' }, { name: 'b', content: 'other' }]));
  data.nodes.set('/mnt/out', { type: 'directory' });
  const target = { id: 'out', path: '/mnt/out', permissions: ['read'] };
  data.config.servers.get('test').mounts.set('out', target);
  const args = { ...params('logs.tar'), destinationMountId: 'out', destinationPath: '.' };
  assert.equal((await data.service.run('extract_archive', args)).error.code, 'PERMISSION_DENIED');
  target.permissions = ['write'];
  data.nodes.set('/mnt/out/b', { type: 'file', content: Buffer.from('old') });
  assert.equal((await data.service.run('extract_archive', args)).error.code, 'ALREADY_EXISTS');
  assert.equal(data.nodes.has('/mnt/out/a'), false);
  assert.equal((await data.service.run('extract_archive', { ...args, overwrite: true })).ok, true);
  assert.equal(data.nodes.get('/mnt/out/b').content.toString(), 'other');
  data.nodes.set('/mnt/out/a', { type: 'symlink' });
  assert.equal((await data.service.run('extract_archive', { ...args, overwrite: true })).error.code, 'SYMLINK_DENIED');
  data.mount.permissions = ['write'];
  assert.equal((await data.service.run('extract_archive', args)).error.code, 'PERMISSION_DENIED');
});

test('archive entry budgets and unsupported formats fail clearly without writes', async () => {
  const data = fixture('many.tar', await tarBytes([{ name: 'a' }, { name: 'b' }]), { security: { maxOperationEntries: 1 } });
  assert.equal((await data.service.run('extract_archive', { ...params('many.tar'), destinationPath: 'out' })).error.code, 'LIMIT_EXCEEDED');
  assert.equal((await data.service.run('read_archive', params('a.txt'))).error.code, 'UNSUPPORTED_ARCHIVE');
  data.nodes.set('/mnt/logs/broken.gz', { type: 'file', content: Buffer.from('not gzip') });
  assert.equal((await data.service.run('read_archive', params('broken.gz'))).error.code, 'INVALID_ARCHIVE');
  assert.equal(data.nodes.has('/mnt/logs/out'), false);
});

test('search can select filenames and inspect gzip/zip log contents without extracting', async () => {
  const data = fixture('log.gz', gzipSync(Buffer.from('archive-only needle\n')));
  data.nodes.set('/mnt/logs/log.zip', { type: 'file', content: await zipBytes([{ name: 'inside.log', content: 'archive-only needle\n' }]) });
  const plain = await data.service.run('search_files', { ...params(), keyword: 'archive-only', filePattern: 'log.*' });
  assert.equal(plain.data.matches.length, 0);
  const result = await data.service.run('search_files', { ...params(), keyword: 'archive-only', filePattern: 'log.*', includeArchives: true });
  assert.equal(result.data.matches.length, 2);
  assert.deepEqual(result.data.matches.map((match) => match.entry).sort(), ['inside.log', 'log']);
  assert.ok(result.meta.scanBytes > result.meta.bytesRead);
  assert.equal(data.calls.some((call) => call.method === 'mkdir'), false);
  data.nodes.set('/mnt/logs/中文😀.log', { type: 'file', content: Buffer.from('unicode marker\n') });
  const unicode = await data.service.run('search_files', { ...params(), keyword: 'unicode marker', filePattern: '???.log' });
  assert.equal(unicode.data.matches[0].path, '中文😀.log');
});
test('search skips an over-budget archive and still searches ordinary files', async () => {
  const data = fixture('large.gz', gzipSync(Buffer.from('compressed text')), { security: { maxArchiveBytes: 1 } });
  data.nodes.set('/mnt/logs/ordinary.log', { type: 'file', content: Buffer.from('find-this-marker\n') });
  const result = await data.service.run('search_files', { ...params(), keyword: 'find-this-marker', includeArchives: true });
  assert.equal(result.data.matches.length, 1);
  assert.equal(result.meta.skipped.archiveLimit, 1);
  assert.equal(result.meta.truncated, true);
  assert.ok(result.meta.scanBytes < data.config.security.maxScanBytes);
});
