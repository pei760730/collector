/**
 * 極簡結構化 logger —— 不引第三方,夠用就好。
 * LOG_LEVEL=debug|info|warn|error(預設 info)。
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const current = (): Level => {
  const v = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return (["debug", "info", "warn", "error"] as Level[]).includes(v as Level)
    ? (v as Level)
    : "info";
};

function emit(level: Level, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[current()]) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (extra !== undefined) fn(line, extra);
  else fn(line);
}

export const logger = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
