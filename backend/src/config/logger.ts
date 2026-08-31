type Level = "debug" | "info" | "warn" | "error";

const WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Structured JSON logger with no dependencies.
 *
 * One JSON object per line is what log shippers expect; swap in pino later
 * without changing a single call site.
 */
export function createLogger(level: Level = "info", bindings: Record<string, unknown> = {}): Logger {
  const threshold = WEIGHT[level];

  const write = (entryLevel: Level, message: string, data?: Record<string, unknown>): void => {
    if (WEIGHT[entryLevel] < threshold) return;
    const line = JSON.stringify({
      level: entryLevel,
      time: new Date().toISOString(),
      message,
      ...bindings,
      ...data,
    });
    if (entryLevel === "error" || entryLevel === "warn") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (message, data) => write("debug", message, data),
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}
