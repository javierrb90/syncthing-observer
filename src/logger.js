const levels = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
});

export function createLogger(levelName) {
  const threshold = levels[levelName] ?? levels.info;

  function write(level, event, fields = {}) {
    if (levels[level] < threshold) return;

    const entry = {
      time: new Date().toISOString(),
      level,
      event,
      ...fields
    };

    const output = JSON.stringify(entry);
    if (level === "error") console.error(output);
    else if (level === "warn") console.warn(output);
    else console.log(output);
  }

  return Object.freeze({
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  });
}
