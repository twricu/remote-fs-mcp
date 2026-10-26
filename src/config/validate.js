import * as z from 'zod/v4';
import { isIP } from 'node:net';
import { DEFAULTS, LIMIT, PERMISSIONS, READ_ONLY_PERMISSIONS } from '../common/constants.js';

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
export const hostSchema = z.string().min(1).max(253).refine((value) => isIP(value) !== 0 || /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(value));
const text = z.string().min(1).max(4096).refine((value) => !value.includes('\0'));
const secret = z.string().min(1).max(65536);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
const password = z.strictObject({ type: z.literal('password'), password: secret.optional(), passwordEnv: envName.optional() }).refine((auth) => (auth.password !== undefined) !== (auth.passwordEnv !== undefined));
const key = z.strictObject({ type: z.literal('private-key'), privateKeyPath: text, passphrase: secret.optional(), passphraseEnv: envName.optional() }).refine((auth) => !(auth.passphrase !== undefined && auth.passphraseEnv !== undefined));
const auth = z.union([password, key, z.strictObject({ type: z.literal('agent') }), z.strictObject({ type: z.literal('auto') })]);
const integer = (min, max) => z.number().int().min(min).max(max);
export const securitySchema = z.strictObject({
  followSymlinks: z.literal(false).default(false),
  maxReadBytes: integer(1, LIMIT.READ_BYTES).default(DEFAULTS.maxReadBytes),
  maxWriteBytes: integer(1, LIMIT.WRITE_BYTES).default(DEFAULTS.maxWriteBytes),
  maxSearchResults: integer(1, 10000).default(DEFAULTS.maxSearchResults),
  maxScanBytes: integer(1, LIMIT.SCAN_BYTES).default(DEFAULTS.maxScanBytes),
  maxSearchDepth: integer(0, 256).default(DEFAULTS.maxSearchDepth),
  maxDirectoryEntries: integer(1, 1000000).default(DEFAULTS.maxDirectoryEntries),
  maxOperationEntries: integer(1, 10000000).default(DEFAULTS.maxOperationEntries),
  maxArchiveBytes: integer(1, LIMIT.ARCHIVE_BYTES).default(DEFAULTS.maxArchiveBytes),
  maxExtractBytes: integer(1, LIMIT.EXTRACT_BYTES).default(DEFAULTS.maxExtractBytes),
  maxLineBytes: integer(1, LIMIT.READ_BYTES).default(DEFAULTS.maxLineBytes),
  connectionTimeoutMs: integer(1000, 300000).default(DEFAULTS.connectionTimeoutMs),
  operationTimeoutMs: integer(1000, 3600000).default(DEFAULTS.operationTimeoutMs),
  maxConcurrentOperations: integer(1, 64).default(DEFAULTS.maxConcurrentOperations)
}).refine((security) => security.connectionTimeoutMs <= security.operationTimeoutMs);
export const configSchema = z.strictObject({
  version: z.literal(1),
  servers: z.array(z.strictObject({
    id: idSchema,
    connection: z.strictObject({ host: hostSchema, port: integer(1, 65535).optional(), username: text.optional(), auth: auth.default({ type: 'auto' }), knownHostsFile: text.default('~/.ssh/known_hosts') }),
    mounts: z.array(z.strictObject({ id: idSchema, path: text, permissions: z.array(z.enum(Object.values(PERMISSIONS))).min(1).max(Object.keys(PERMISSIONS).length).refine((values) => new Set(values).size === values.length).default([...READ_ONLY_PERMISSIONS]) })).min(1)
  })).min(1),
  security: securitySchema.prefault({})
});
