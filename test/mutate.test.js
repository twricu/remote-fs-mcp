import test from 'node:test';
import assert from 'node:assert/strict';
import { mockService, params, attrs } from './helpers/mock.js';

const enabled = () => mockService({ permissions: ['read', 'write', 'delete'] });

test('read covers all reads, write covers rename/move, delete is separately required', async () => {
  const fixture = mockService();
  for (const [tool, extra] of [['write_file', { content: 'x' }], ['create_directory', {}], ['move_path', { destinationPath: 'moved' }], ['delete_path', {}], ['extract_archive', { destinationPath: 'out' }]]) {
    assert.equal((await fixture.service.run(tool, { ...params('a.txt'), ...extra })).error.code, 'PERMISSION_DENIED', tool);
  }
  assert.equal(fixture.connectionCount(), 0);
  const write = mockService({ permissions: ['write'] });
  assert.equal((await write.service.run('move_path', { ...params('a.txt'), destinationPath: 'moved' })).ok, true);
  assert.equal((await write.service.run('write_file', { ...params('new'), content: 'x' })).ok, true);
  assert.equal((await write.service.run('delete_path', params('new'))).error.code, 'PERMISSION_DENIED');
  assert.equal((await write.service.run('read_file', params('new'))).error.code, 'PERMISSION_DENIED');
  const remove = mockService({ permissions: ['delete'] });
  assert.equal((await remove.service.run('delete_path', params('a.txt'))).ok, true);
  assert.equal((await remove.service.run('write_file', { ...params('new'), content: 'x' })).error.code, 'PERMISSION_DENIED');
});

test('write creates, overwrites and appends UTF-8 or canonical base64', async () => {
  const fixture = enabled();
  assert.equal((await fixture.service.run('write_file', { ...params('created'), content: '中文😀' })).data.bytesWritten, 10);
  assert.equal(fixture.nodes.get('/mnt/logs/created').content.toString(), '中文😀');
  assert.equal((await fixture.service.run('write_file', { ...params('created'), content: 'oops' })).error.code, 'ALREADY_EXISTS');
  assert.equal((await fixture.service.run('write_file', { ...params('created'), content: 'A', mode: 'overwrite' })).ok, true);
  assert.equal((await fixture.service.run('write_file', { ...params('created'), content: 'BC', mode: 'append' })).ok, true);
  assert.equal(fixture.nodes.get('/mnt/logs/created').content.toString(), 'ABC');
  assert.equal((await fixture.service.run('write_file', { ...params('binary-new'), content: 'AP8=', encoding: 'base64' })).ok, true);
  assert.deepEqual(fixture.nodes.get('/mnt/logs/binary-new').content, Buffer.from([0, 255]));
  assert.equal((await fixture.service.run('write_file', { ...params('created'), content: '', mode: 'overwrite' })).ok, true);
  assert.equal(fixture.nodes.get('/mnt/logs/created').content.length, 0);
});

test('write rejects byte overflow, malformed content and unsafe paths before connection', async () => {
  const fixture = mockService({ permissions: ['write'], security: { maxWriteBytes: 4 } });
  for (const extra of [{ content: '中文' }, { content: 'YQ', encoding: 'base64' }, { content: '\uD800' }]) {
    assert.equal((await fixture.service.run('write_file', { ...params('new'), ...extra })).error.code, 'INVALID_ARGUMENT');
  }
  for (const value of ['../outside', '/outside']) assert.equal((await fixture.service.run('write_file', { ...params(value), content: 'ok' })).error.code, 'PATH_OUT_OF_SCOPE');
  assert.equal(fixture.connectionCount(), 0);
  assert.equal(fixture.nodes.has('/mnt/logs/new'), false);
});

test('write verifies the opened handle before truncating a replaced special file', async () => {
  const fixture = enabled();
  const original = fixture.service.open;
  fixture.service.open = async (...args) => {
    const io = await original(...args);
    io.channel.fstat = (_handle, callback) => queueMicrotask(() => callback(null, attrs({ type: 'fifo' })));
    return io;
  };
  const before = Buffer.from(fixture.nodes.get('/mnt/logs/a.txt').content);
  const result = await fixture.service.run('write_file', { ...params('a.txt'), content: 'no', mode: 'overwrite' });
  assert.equal(result.error.code, 'NOT_REGULAR_FILE');
  assert.equal(fixture.calls.some((call) => ['write', 'fsetstat'].includes(call.method)), false);
  assert.deepEqual(fixture.nodes.get('/mnt/logs/a.txt').content, before);
});

test('recursive mkdir stays within the mount and rejects links or file parents', async () => {
  const fixture = enabled();
  assert.equal((await fixture.service.run('create_directory', params('one/two'))).error.code, 'NOT_FOUND');
  assert.equal((await fixture.service.run('create_directory', { ...params('one/two'), recursive: true })).ok, true);
  assert.equal((await fixture.service.run('create_directory', params('one/two'))).error.code, 'ALREADY_EXISTS');
  assert.equal((await fixture.service.run('create_directory', { ...params('one/two'), recursive: true })).data.created, false);
  assert.equal((await fixture.service.run('create_directory', { ...params('link/child'), recursive: true })).error.code, 'SYMLINK_DENIED');
  assert.equal((await fixture.service.run('create_directory', { ...params('a.txt/child'), recursive: true })).error.code, 'NOT_DIRECTORY');
  assert.ok(fixture.calls.filter((call) => call.method === 'mkdir').every((call) => call.args[0].startsWith('/mnt/logs/')));
});

test('move across mounts checks write on both sides and requires explicit overwrite', async () => {
  const fixture = enabled();
  const target = { id: 'target', path: '/mnt/target', permissions: ['read'] };
  fixture.config.servers.get('test').mounts.set('target', target);
  fixture.nodes.set('/mnt/target', { type: 'directory' });
  const args = { ...params('a.txt'), destinationMountId: 'target', destinationPath: 'renamed' };
  assert.equal((await fixture.service.run('move_path', args)).error.code, 'PERMISSION_DENIED');
  target.permissions = ['write'];
  assert.equal((await fixture.service.run('move_path', args)).ok, true);
  assert.equal(fixture.nodes.has('/mnt/logs/a.txt'), false);
  assert.equal(fixture.nodes.get('/mnt/target/renamed').content.toString(), 'first\nHello world\nlast\n');
  assert.equal((await fixture.service.run('move_path', { ...params('unicode'), destinationMountId: 'target', destinationPath: 'renamed' })).error.code, 'ALREADY_EXISTS');
  assert.equal((await fixture.service.run('move_path', { ...params('unicode'), destinationMountId: 'target', destinationPath: 'renamed', overwrite: true })).ok, true);
  assert.equal(fixture.nodes.get('/mnt/target/renamed').content.toString(), '中文😀hello\r\n第二行\n');
  for (const [source, destination] of [['.', 'other'], ['sub', '.'], ['sub', 'sub/nested']]) {
    assert.equal((await fixture.service.run('move_path', { ...params(source), destinationPath: destination })).ok, false);
  }
});
test('unsupported atomic replacement never falls back to deleting the target', async () => {
  const fixture = enabled();
  const original = fixture.service.open;
  fixture.service.open = async (...args) => {
    const io = await original(...args);
    io.channel.ext_openssh_rename = () => { throw new Error('Server does not support this extended request'); };
    return io;
  };
  const before = Buffer.from(fixture.nodes.get('/mnt/logs/a.txt').content);
  const result = await fixture.service.run('move_path', { ...params('unicode'), destinationPath: 'a.txt', overwrite: true });
  assert.equal(result.error.code, 'UNSUPPORTED_OPERATION');
  assert.equal(fixture.calls.some((call) => call.method === 'unlink'), false);
  assert.deepEqual(fixture.nodes.get('/mnt/logs/a.txt').content, before);
});

test('delete requires explicit recursion and protects mount roots, links and special files', async () => {
  const fixture = enabled();
  assert.equal((await fixture.service.run('delete_path', params())).error.code, 'PERMISSION_DENIED');
  assert.equal((await fixture.service.run('delete_path', params('sub'))).error.code, 'NOT_EMPTY');
  for (const [file, code] of [['link', 'SYMLINK_DENIED'], ['pipe', 'NOT_REGULAR_FILE'], ['missing', 'NOT_FOUND']]) assert.equal((await fixture.service.run('delete_path', params(file))).error.code, code);
  const deleted = await fixture.service.run('delete_path', { ...params('sub'), recursive: true });
  assert.equal(deleted.data.filesDeleted, 1);
  assert.equal(deleted.data.directoriesDeleted, 1);
  assert.equal(fixture.nodes.has('/mnt/logs/sub'), false);
});

test('recursive deletion validates every child and budget before changing anything', async () => {
  const fixture = enabled();
  fixture.nodes.set('/mnt/logs/sub/link', { type: 'symlink' });
  assert.equal((await fixture.service.run('delete_path', { ...params('sub'), recursive: true })).error.code, 'SYMLINK_DENIED');
  assert.equal(fixture.calls.some((call) => call.method === 'unlink'), false);
  fixture.nodes.delete('/mnt/logs/sub/link');
  fixture.nodes.set('/mnt/logs/sub/another', { type: 'file', content: Buffer.from('x') });
  fixture.config.security.maxOperationEntries = 1;
  assert.equal((await fixture.service.run('delete_path', { ...params('sub'), recursive: true })).error.code, 'LIMIT_EXCEEDED');
  assert.equal(fixture.calls.some((call) => call.method === 'unlink'), false);
});

test('a failed write reports possible changes instead of silently inviting retries', async () => {
  const fixture = enabled();
  const original = fixture.service.open;
  fixture.service.open = async (...args) => {
    const io = await original(...args);
    io.channel.write = (_handle, _buffer, _offset, _length, _position, callback) => queueMicrotask(() => callback(new Error('private upstream detail')));
    return io;
  };
  const result = await fixture.service.run('write_file', { ...params('created'), content: 'payload' });
  assert.equal(result.ok, false);
  assert.equal(result.meta.mayHaveChanged, true);
  assert.equal(JSON.stringify(result).includes('private upstream'), false);
  assert.equal(fixture.nodes.has('/mnt/logs/created'), true);
});
