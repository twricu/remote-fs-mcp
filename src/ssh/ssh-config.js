import path from 'node:path';
import { CODE, fail } from '../common/errors.js';

function tokens(line) {
  const output = [];
  let value = '';
  let quote = '';
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = '';
      else value += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#') break;
    else if (/\s/u.test(char) || (char === '=' && output.length === 0)) {
      if (value) { output.push(value); value = ''; }
    } else value += char;
  }
  if (quote) fail(CODE.CONFIG_INVALID, 'sshConfig.syntax');
  if (value) output.push(value);
  return output;
}
export function parseSshConfig(source, host) {
  const result = { identities: [] };
  let active = true;
  for (const line of source.split(/\r?\n/u)) {
    const values = tokens(line);
    if (values.length === 0) continue;
    const name = values.shift().toLowerCase();
    if (name === 'include' || name === 'match') fail(CODE.CONFIG_INVALID, 'sshConfig.unsupportedScope');
    if (name === 'host') {
      if (!values.length || values.some((value) => value !== '*' && !/^[A-Za-z0-9._-]+$/u.test(value))) fail(CODE.CONFIG_INVALID, 'sshConfig.hostPattern');
      active = values.some((value) => value === '*' || value.toLowerCase() === host.toLowerCase());
      continue;
    }
    if (!active) continue;
    if (!['hostname', 'user', 'port', 'identityfile', 'identityagent'].includes(name) || values.length !== 1 || /[%$`]/u.test(values[0])) fail(CODE.CONFIG_INVALID, 'sshConfig.unsupportedDirective');
    const value = values[0];
    if (name === 'identityfile') {
      if (!path.isAbsolute(value) && !value.startsWith('~/')) fail(CODE.CONFIG_INVALID, 'sshConfig.identityFile');
      if (!result.identities.includes(value)) result.identities.push(value);
    } else if (result[name] === undefined) result[name] = value;
  }
  return result;
}
