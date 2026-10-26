import tar from 'tar-stream';
import yazl from 'yazl';
import { gzipSync } from 'node:zlib';

async function bytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function tarBytes(entries, gzip = false) {
  const pack = tar.pack();
  const pending = bytes(pack);
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '');
    pack.entry({ name: entry.name, type: entry.type ?? 'file', mode: entry.mode ?? 0o644, linkname: entry.linkname, size: content.length }, content);
  }
  pack.finalize();
  const result = await pending;
  if (gzip) return gzipSync(result);
  return result;
}

export async function zipBytes(entries) {
  const zip = new yazl.ZipFile();
  const pending = bytes(zip.outputStream);
  for (const entry of entries) {
    if (entry.type === 'directory') zip.addEmptyDirectory(entry.name);
    else zip.addBuffer(Buffer.from(entry.content ?? ''), entry.name, { mode: entry.mode ?? 0o100644, compress: entry.compress ?? true });
  }
  zip.end();
  return await pending;
}
