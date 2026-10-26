import { CODE, fail } from '../common/errors.js';
import { PERMISSIONS, TOOL, MUTATING_TOOLS } from '../common/constants.js';
import { resolvePath } from './path-policy.js';

export function authorize(config, tool, args) {
  const server = config.servers.get(args.serverId);
  if (!server) fail(CODE.SERVER_NOT_FOUND);
  const mount = server.mounts.get(args.mountId);
  if (!mount) fail(CODE.MOUNT_NOT_FOUND);
  let permission = PERMISSIONS.READ;
  if (MUTATING_TOOLS.has(tool) && tool !== TOOL.EXTRACT) permission = PERMISSIONS.WRITE;
  if (tool === TOOL.DELETE) permission = PERMISSIONS.DELETE;
  if (!mount.permissions.includes(permission)) fail(CODE.PERMISSION_DENIED);
  const authorized = { server, mount, absolute: resolvePath(mount.path, args.path) };
  if (tool === TOOL.DELETE || tool === TOOL.MOVE) {
    if (args.path === '.') fail(CODE.PERMISSION_DENIED, 'mountRoot');
  }
  if (tool === TOOL.MOVE || tool === TOOL.EXTRACT) {
    const destination = server.mounts.get(args.destinationMountId ?? args.mountId);
    if (!destination) fail(CODE.MOUNT_NOT_FOUND);
    if (!destination.permissions.includes(PERMISSIONS.WRITE)) fail(CODE.PERMISSION_DENIED);
    authorized.destination = { mount: destination, absolute: resolvePath(destination.path, args.destinationPath) };
    if (tool === TOOL.MOVE && args.destinationPath === '.') fail(CODE.PERMISSION_DENIED, 'mountRoot');
  }
  return authorized;
}
