export const VERSION = '0.1.0';
export const DEFAULT_READ_BYTES = 1048576;
export const PERMISSIONS = Object.freeze({ READ: 'read', WRITE: 'write', DELETE: 'delete' });
export const READ_ONLY_PERMISSIONS = Object.freeze([PERMISSIONS.READ]);
export const CONNECTION_STATE = Object.freeze({ DISCONNECTED: 'disconnected', CONNECTING: 'connecting', READY: 'ready', CLOSING: 'closing' });
export const TOOL = Object.freeze({
  MOUNTS: 'list_mounts', DIRECTORY: 'list_directory', STAT: 'stat_file', READ: 'read_file', TAIL: 'tail_file', SEARCH: 'search_files',
  WRITE: 'write_file', MKDIR: 'create_directory', MOVE: 'move_path', DELETE: 'delete_path', ARCHIVE: 'read_archive', EXTRACT: 'extract_archive'
});
export const MUTATING_TOOLS = new Set([TOOL.WRITE, TOOL.MKDIR, TOOL.MOVE, TOOL.DELETE, TOOL.EXTRACT]);
export const REASON = Object.freeze({
  READ: 'read_limit', RESULTS: 'result_limit', ENTRIES: 'entry_limit', FILES: 'file_limit',
  SCAN: 'scan_bytes_limit', DEPTH: 'depth_limit', LINE: 'line_limit', CHANGED: 'file_changed',
  SKIPPED: 'skipped_error', OUTPUT: 'output_limit'
});
export const DEFAULTS = Object.freeze({
  followSymlinks: false,
  maxReadBytes: 4194304,
  maxWriteBytes: 16777216,
  maxSearchResults: 1000,
  maxScanBytes: 268435456,
  maxSearchDepth: 16,
  maxDirectoryEntries: 10000,
  maxOperationEntries: 100000,
  maxArchiveBytes: 134217728,
  maxExtractBytes: 268435456,
  maxLineBytes: 1048576,
  connectionTimeoutMs: 10000,
  operationTimeoutMs: 60000,
  maxConcurrentOperations: 4
});
export const LIMIT = Object.freeze({
  CONFIG: 1048576, KEY: 1048576, SSH_CONFIG: 262144, KNOWN_HOSTS: 4194304,
  PATH_BYTES: 4096,
  READ_BYTES: 16777216, WRITE_BYTES: 1073741824, SCAN_BYTES: 8589934592, ARCHIVE_BYTES: 1073741824, EXTRACT_BYTES: 2147483648,
  CONTEXT: 4096, KEYWORD: 4096,
  RESULT: 67108864, QUEUE: 64, CHUNK: 32768, TAIL_LINES: 100000, EXIT_MS: 2000
});
