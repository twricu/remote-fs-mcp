export const CODE = Object.freeze(Object.fromEntries([
  'CONFIG_INVALID', 'INVALID_ARGUMENT', 'SERVER_NOT_FOUND', 'MOUNT_NOT_FOUND',
  'PERMISSION_DENIED', 'PATH_OUT_OF_SCOPE', 'SYMLINK_DENIED', 'HOST_KEY_REJECTED',
  'AUTH_FAILED', 'NOT_FOUND', 'NOT_REGULAR_FILE', 'NOT_DIRECTORY', 'UNSUPPORTED_CONTENT',
  'LIMIT_EXCEEDED', 'TIMEOUT', 'CANCELLED', 'REMOTE_ERROR', 'ALREADY_EXISTS', 'NOT_EMPTY', 'INVALID_ARCHIVE', 'UNSUPPORTED_ARCHIVE', 'UNSUPPORTED_OPERATION'
].map((code) => [code, code])));

const MESSAGE = Object.freeze({
  CONFIG_INVALID: 'Invalid local configuration.', INVALID_ARGUMENT: 'Invalid tool argument.',
  SERVER_NOT_FOUND: 'Server ID is not configured.', MOUNT_NOT_FOUND: 'Mount ID is not configured.',
  PERMISSION_DENIED: 'Operation is not permitted.', PATH_OUT_OF_SCOPE: 'Path is outside the allowed policy.',
  SYMLINK_DENIED: 'Symbolic links are not permitted.', HOST_KEY_REJECTED: 'SSH host key is unknown, changed, revoked or unsupported.',
  AUTH_FAILED: 'SSH authentication failed or is unsupported.', NOT_FOUND: 'Target does not exist.',
  NOT_REGULAR_FILE: 'Target is not a regular file.', NOT_DIRECTORY: 'Target is not a directory.',
  UNSUPPORTED_CONTENT: 'Only valid UTF-8 text without NUL is supported.', LIMIT_EXCEEDED: 'Resource limit exceeded.',
  TIMEOUT: 'Operation deadline exceeded.', CANCELLED: 'Operation cancelled.', REMOTE_ERROR: 'Remote operation failed.',
  ALREADY_EXISTS: 'Target already exists.', NOT_EMPTY: 'Directory is not empty.',
  INVALID_ARCHIVE: 'Archive is malformed or contains unsafe entries.', UNSUPPORTED_ARCHIVE: 'Archive format or encryption is not supported.',
  UNSUPPORTED_OPERATION: 'The server does not support this filesystem operation.'
});

export class FsError extends Error {
  constructor(code, detail) {
    let message = MESSAGE[code];
    if (detail) message += ` (${detail})`;
    super(message);
    this.name = 'FsError';
    this.code = code;
    // detail must be a controlled field label, never an upstream message or value.
    if (detail) this.detail = detail;
  }
}
export function fail(code, detail) { throw new FsError(code, detail); }
export function safeError(error) {
  if (error instanceof FsError) return error;
  if (error?.code === 2 || error?.code === 'ENOENT') return new FsError(CODE.NOT_FOUND);
  if (error?.code === 3 || error?.code === 'EACCES') return new FsError(CODE.PERMISSION_DENIED);
  if (error?.code === 11 || error?.code === 'EEXIST') return new FsError(CODE.ALREADY_EXISTS);
  if (error?.code === 18 || error?.code === 'ENOTEMPTY') return new FsError(CODE.NOT_EMPTY);
  if (error?.code === 8 || error?.code === 'ENOSYS') return new FsError(CODE.UNSUPPORTED_OPERATION);
  return new FsError(CODE.REMOTE_ERROR);
}
export function errorResult(error) {
  const safe = safeError(error);
  return { ok: false, error: { code: safe.code, message: safe.message } };
}
