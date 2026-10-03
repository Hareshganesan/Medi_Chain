const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

/** Minimal structured logger. Set LOG_LEVEL=silent in tests. */
export function createLogger(service) {
  const threshold = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;
  const log = (level) => (msg, meta) => {
    if (LEVELS[level] < threshold) return;
    const time = new Date().toISOString().slice(11, 23);
    const extra = meta ? ' ' + JSON.stringify(meta) : '';
    const line = `${COLORS[level]}${time} ${level.toUpperCase().padEnd(5)}\x1b[0m [${service}] ${msg}${extra}`;
    (level === 'error' ? console.error : console.log)(line);
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}
