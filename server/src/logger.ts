export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = ORDER[level] ?? ORDER.info;
  const write = (lvl: Exclude<LogLevel, 'silent'>, message: string, meta?: unknown) => {
    if (ORDER[lvl] < threshold) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${message}`;
    const out = lvl === 'error' || lvl === 'warn' ? console.error : console.log;
    if (meta === undefined) out(line);
    else out(line, meta instanceof Error ? (meta.stack ?? meta.message) : meta);
  };
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
}
