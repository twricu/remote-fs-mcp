import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const file = new URL('README.md', root);
const readme = await readFile(file, 'utf8');
const intro = /^(# [^\n]+\n\n)([^\n]+)/u;
if (!intro.test(readme)) throw new Error('README must have a one-line introduction after its title.');
const updated = readme.replace(intro, (_match, heading) => heading + metadata.description);
if (process.argv.includes('--check')) {
  if (readme !== updated) throw new Error('README introduction differs from package.json; run npm run docs:sync.');
} else if (readme !== updated) {
  await writeFile(file, updated);
}
