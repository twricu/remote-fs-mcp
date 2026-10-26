import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loopback } from '../test/helpers/loopback.js';
import { params } from '../test/helpers/mock.js';

const spec = process.argv[2];
const npmCli = process.env.npm_execpath;
if (!spec || !npmCli) throw new Error('Usage: npm run test:package -- <absolute-tarball-path-or-package@version>');

test('npm/npx consumer acceptance from an empty directory', { timeout: 240000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rfm consumer '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = path.join(directory, 'cache');
  const cwd = path.join(directory, 'empty working directory');
  await mkdir(cwd);

  for (const type of ['default-read-only', 'password', 'password-env', 'private-key', 'encrypted-key', 'agent']) {
    await t.test(type, { timeout: 180000 }, async (context) => {
      const fixture = await loopback(context);
      let auth = { type: 'password', password: fixture.password };
      if (type === 'password-env') auth = { type: 'password', passwordEnv: 'FIXTURE_PASSWORD' };
      else if (type === 'private-key') auth = { type, privateKeyPath: fixture.keyFile };
      else if (type === 'encrypted-key') {
        const passphrase = 'temporary-package-test-passphrase';
        await writeFile(fixture.keyFile, createPrivateKey(fixture.key.pem).export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase }));
        auth = { type: 'private-key', privateKeyPath: fixture.keyFile, passphrase };
      } else if (type === 'agent') auth = { type };
      let permissions;
      if (type !== 'default-read-only') permissions = ['read', 'write', 'delete'];
      const config = await fixture.writeConfig(auth, 'private config.yaml', permissions);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [npmCli, 'exec', '--yes', `--package=${spec}`, '--registry=https://registry.npmjs.org/', `--cache=${cache}`, '--fetch-retries=0', '--fetch-timeout=15000', '--', 'remote-fs-mcp', '--config', config],
        cwd,
        stderr: 'pipe',
        env: { FIXTURE_PASSWORD: fixture.password, SSH_AUTH_SOCK: fixture.endpoint }
      });
      let logs = '';
      transport.stderr.on('data', (bytes) => { logs += bytes; });
      const client = new Client({ name: 'consumer-check', version: '1' });
      context.after(() => client.close());
      // Include the cold npm download in the documented 120-second startup budget.
      await client.connect(transport, { timeout: 120000 });
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), ['create_directory', 'delete_path', 'extract_archive', 'list_directory', 'list_mounts', 'move_path', 'read_archive', 'read_file', 'search_files', 'stat_file', 'tail_file', 'write_file']);
      const call = async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.structuredContent.ok, true, `${name}: ${JSON.stringify(result.structuredContent.error)}`);
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
        return result.structuredContent;
      };
      assert.equal((await call('list_mounts', {})).data.mounts.length, 1);
      assert.equal(fixture.connectionCount(), 0);
      const listed = await call('list_directory', params());
      assert.ok(listed.data.entries.some((entry) => entry.name === 'a.txt'));
      assert.equal((await call('stat_file', params('a.txt'))).data.size, 23);
      assert.equal((await call('read_file', params('a.txt'))).data.content, 'first\nHello world\nlast\n');
      assert.equal((await call('tail_file', { ...params('a.txt'), lines: 1 })).data.content, 'last\n');
      const search = await call('search_files', { ...params(), keyword: 'Hello' });
      assert.deepEqual(search.data.matches.map((match) => [match.path, match.line]).sort(), [['a.txt', 2], ['sub/deep.txt', 1]]);
      for (const [name, args, code] of [
        ['read_file', params('../secret'), 'PATH_OUT_OF_SCOPE'],
        ['read_file', params('link'), 'SYMLINK_DENIED'],
        ['read_file', params('pipe'), 'NOT_REGULAR_FILE'],
        ['read_file', params('binary'), 'UNSUPPORTED_CONTENT'],
        ['read_file', params('missing'), 'NOT_FOUND']
      ]) {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, code);
      }
      assert.equal((await call('read_file', params('empty'))).data.eof, true);
      if (type === 'default-read-only') {
        for (const [name, args] of [
          ['write_file', { ...params('forbidden'), content: 'x' }],
          ['delete_path', params('a.txt')],
          ['move_path', { ...params('a.txt'), destinationPath: 'forbidden' }]
        ]) {
          const result = await client.callTool({ name, arguments: args });
          assert.equal(result.structuredContent.error.code, 'PERMISSION_DENIED');
        }
        assert.equal(fixture.nodes.has('/mnt/logs/forbidden'), false);
        assert.equal(fixture.nodes.has('/mnt/logs/a.txt'), true);
        return;
      }
      await call('create_directory', { ...params('scratch/nested'), recursive: true });
      await call('write_file', { ...params('scratch/nested/file'), content: 'one' });
      await call('write_file', { ...params('scratch/nested/file'), content: 'two', mode: 'append' });
      assert.equal((await call('read_file', params('scratch/nested/file'))).data.content, 'onetwo');
      await call('write_file', { ...params('scratch/nested/file'), content: 'replaced', mode: 'overwrite' });
      await call('move_path', { ...params('scratch/nested/file'), destinationPath: 'scratch/nested/moved' });
      assert.equal((await call('read_file', params('scratch/nested/moved'))).data.content, 'replaced');
      fixture.nodes.set('/mnt/logs/source.gz', { type: 'file', content: gzipSync(Buffer.from('packed archive\n')) });
      assert.equal((await call('read_archive', { ...params('source.gz'), mode: 'read' })).data.content, 'packed archive\n');
      await call('extract_archive', { ...params('source.gz'), destinationPath: 'scratch/extracted' });
      assert.equal((await call('read_file', params('scratch/extracted/source'))).data.content, 'packed archive\n');
      await call('delete_path', { ...params('scratch'), recursive: true });
      assert.equal([...fixture.nodes.keys()].some((name) => name.startsWith('/mnt/logs/scratch')), false);
      assert.equal(fixture.connectionCount(), 1);
      assert.equal(logs.includes(fixture.password), false);
      assert.equal(logs.includes('Hello world'), false);
      assert.equal(logs.includes('BEGIN RSA'), false);
    });
  }
});
