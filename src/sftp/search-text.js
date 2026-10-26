import { CODE, fail } from '../common/errors.js';
import { LIMIT, REASON } from '../common/constants.js';
import { decodeText, clipText } from './text.js';
import { mark, skip } from './read.js';

export function matchesPattern(name, pattern) {
  if (pattern === undefined) return true;
  const text = Array.from(name);
  const tokens = Array.from(pattern);
  let input = 0;
  let token = 0;
  let star = -1;
  let retry = 0;
  while (input < text.length) {
    if (tokens[token] === '?' || tokens[token] === text[input]) { input++; token++; }
    else if (tokens[token] === '*') { star = token++; retry = input; }
    else if (star >= 0) { token = star + 1; input = ++retry; }
    else return false;
  }
  while (tokens[token] === '*') token++;
  return token === tokens.length;
}

export class TextSearch {
  constructor(args, security, meta, matches, location, stop, fits) {
    this.args = args; this.security = security; this.meta = meta; this.matches = matches;
    this.location = location; this.stop = stop; this.fits = fits;
    this.pending = Buffer.alloc(0); this.discarding = false; this.line = 1; this.stopped = false;
    this.keyword = args.keyword;
    if (!args.caseSensitive) this.keyword = args.keyword.toLowerCase();
  }
  processLine(bytes) {
    const text = decodeText(bytes).replace(/\r$/u, '');
    let comparable = text;
    if (!this.args.caseSensitive) comparable = text.toLowerCase();
    let index = comparable.indexOf(this.keyword);
    if (index < 0) return;
    if (!this.args.caseSensitive) {
      let folded = 0;
      let original = 0;
      for (const char of text) {
        const length = char.toLowerCase().length;
        if (folded + length > index) break;
        folded += length; original += char.length;
      }
      index = original;
    }
    let start = Math.max(0, index - 128);
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start--;
    this.matches.push({ ...this.location, line: this.line, context: clipText(text.slice(start), LIMIT.CONTEXT) });
    if (!this.fits({ matches: this.matches }, this.meta)) {
      this.matches.pop(); this.finishWith(REASON.OUTPUT);
    } else if (this.matches.length >= this.args.maxResults) this.finishWith(REASON.RESULTS);
  }
  finishWith(reason) {
    mark(this.meta, reason); this.stopped = true; this.stop();
  }
  push(bytes) {
    if (bytes.includes(0)) fail(CODE.UNSUPPORTED_CONTENT);
    let start = 0;
    for (let index = 0; index < bytes.length && !this.stopped; index++) {
      if (bytes[index] !== 10) continue;
      if (!this.discarding) {
        const length = this.pending.length + index - start;
        if (length <= this.security.maxLineBytes) this.processLine(Buffer.concat([this.pending, bytes.subarray(start, index)], length));
        else { skip(this.meta, 'longLine'); mark(this.meta, REASON.LINE); }
      }
      this.pending = Buffer.alloc(0); this.discarding = false; start = index + 1; this.line++;
    }
    if (!this.stopped && !this.discarding) {
      const length = this.pending.length + bytes.length - start;
      if (length > this.security.maxLineBytes) {
        this.pending = Buffer.alloc(0); this.discarding = true; skip(this.meta, 'longLine'); mark(this.meta, REASON.LINE);
      } else this.pending = Buffer.concat([this.pending, bytes.subarray(start)], length);
    }
  }
  finish(eof) {
    if (this.stopped || this.discarding || !this.pending.length) return;
    if (eof) this.processLine(this.pending);
    else this.processLine(Buffer.from(decodeText(this.pending, { partialEnd: true })));
  }
}
