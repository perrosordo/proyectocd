import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './env.js';

export function createLogger(logsDir, command) {
  fs.mkdirSync(logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(logsDir, `${command}-${stamp}.log`);

  const write = (level, message, extra) => {
    const line = `[${new Date().toISOString()}] ${level} ${redactSecrets(message)}` +
      (extra !== undefined ? ` ${redactSecrets(JSON.stringify(extra))}` : '');
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
    if (level === 'ERROR') {
      console.error(redactSecrets(message));
    } else {
      console.log(redactSecrets(message));
    }
  };

  return {
    filePath,
    info: (msg, extra) => write('INFO', msg, extra),
    warn: (msg, extra) => write('WARN', msg, extra),
    error: (msg, extra) => write('ERROR', msg, extra),
  };
}
