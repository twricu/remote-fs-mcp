export function audit(event, fields = {}) {
  const allowed = ['tool', 'serverId', 'mountId', 'code', 'durationMs', 'bytesRead', 'count'];
  const entry = { event };
  for (const key of allowed) {
    if (fields[key] !== undefined) entry[key] = fields[key];
  }
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}
