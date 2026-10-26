import * as z from 'zod/v4';
import { idSchema } from '../config/validate.js';
import { DEFAULT_READ_BYTES, LIMIT, TOOL } from '../common/constants.js';

export function toolSchemas(security) {
  const common = { serverId: idSchema, mountId: idSchema, path: z.string().min(1).max(LIMIT.PATH_BYTES).default('.') };
  const integer = (minimum, maximum) => z.number().int().min(minimum).max(maximum);
  const destination = { destinationMountId: idSchema.optional(), destinationPath: z.string().min(1).max(LIMIT.PATH_BYTES) };
  return new Map([
    [TOOL.MOUNTS, z.strictObject({})],
    [TOOL.DIRECTORY, z.strictObject({ ...common, limit: integer(1, security.maxDirectoryEntries).default(Math.min(200, security.maxDirectoryEntries)), offset: integer(0, Number.MAX_SAFE_INTEGER).default(0) })],
    [TOOL.STAT, z.strictObject(common)],
    [TOOL.READ, z.strictObject({ ...common, offset: integer(0, Number.MAX_SAFE_INTEGER).default(0), maxBytes: integer(1, security.maxReadBytes).default(Math.min(DEFAULT_READ_BYTES, security.maxReadBytes)) })],
    [TOOL.TAIL, z.strictObject({ ...common, lines: integer(1, LIMIT.TAIL_LINES).default(100) })],
    [TOOL.SEARCH, z.strictObject({ ...common, keyword: z.string().min(1).max(LIMIT.KEYWORD).refine((value) => Buffer.byteLength(value) <= LIMIT.KEYWORD && !/[\r\n\0]/u.test(value)), maxDepth: integer(0, security.maxSearchDepth).default(security.maxSearchDepth), maxResults: integer(1, security.maxSearchResults).default(Math.min(100, security.maxSearchResults)), caseSensitive: z.boolean().default(true), filePattern: z.string().min(1).max(256).refine((value) => !/[/\\\0]/u.test(value)).optional(), includeArchives: z.boolean().default(false) })],
    [TOOL.WRITE, z.strictObject({ ...common, content: z.string().max(Math.ceil(security.maxWriteBytes * 4 / 3) + 4), encoding: z.enum(['utf-8', 'base64']).default('utf-8'), mode: z.enum(['create', 'overwrite', 'append']).default('create') })],
    [TOOL.MKDIR, z.strictObject({ ...common, recursive: z.boolean().default(false) })],
    [TOOL.MOVE, z.strictObject({ ...common, ...destination, overwrite: z.boolean().default(false) })],
    [TOOL.DELETE, z.strictObject({ ...common, recursive: z.boolean().default(false) })],
    [TOOL.ARCHIVE, z.strictObject({ ...common, mode: z.enum(['list', 'read', 'tail']).default('list'), entry: z.string().min(1).max(LIMIT.PATH_BYTES).optional(), offset: integer(0, Number.MAX_SAFE_INTEGER).default(0), limit: integer(1, security.maxDirectoryEntries).default(Math.min(200, security.maxDirectoryEntries)), maxBytes: integer(1, security.maxReadBytes).default(Math.min(DEFAULT_READ_BYTES, security.maxReadBytes)), lines: integer(1, LIMIT.TAIL_LINES).default(100) })],
    [TOOL.EXTRACT, z.strictObject({ ...common, ...destination, overwrite: z.boolean().default(false) })]
  ]);
}
