import { CODE, fail } from '../common/errors.js';

export function decodeText(buffer, { partialEnd = false, offset = 0 } = {}) {
  if (buffer.includes(0)) fail(CODE.UNSUPPORTED_CONTENT);
  if (offset > 0 && buffer.length && (buffer[0] & 0xc0) === 0x80) fail(CODE.INVALID_ARGUMENT);
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    return decoder.decode(buffer, { stream: partialEnd });
  } catch (_error) { fail(CODE.UNSUPPORTED_CONTENT); }
}
export function clipText(value, maximum) {
  if (Buffer.byteLength(value) <= maximum) return value;
  return decodeText(Buffer.from(value).subarray(0, maximum), { partialEnd: true });
}
