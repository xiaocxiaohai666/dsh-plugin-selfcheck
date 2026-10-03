/**
 * The terminal sink.
 *
 * Console FIRST, and the cordis logger only as a mirror.
 *
 * This ordering is the whole reason the plugin is visible at all. Measured on a
 * real dsh CLI: output written through `ctx.logger` reaches neither the console
 * window that `start-dsh.bat` opens nor the `dsh-run.log` that window is
 * redirected into. Writing to the logger *instead* of the console produces a
 * self-check nobody can see, which is the exact failure this plugin exists to
 * prevent.
 *
 * Every write is guarded, because a diagnostic must never be the thing that
 * takes a boot down.
 * @module dsh-plugin-selfcheck/log
 */

/** Prefix every line carries, so output is attributable when several plugins log. */
export const TAG = '[selfcheck]'

/**
 * Build a sink bound to a context.
 * @param {object} [ctx] - cordis context, used only for the logger mirror.
 * @returns {(line: string, level?: string) => void} a sink that never throws.
 */
export function makeSink(ctx) {
  const logger = resolveLogger(ctx)
  return (line, level = 'info') => {
    writeConsole(line, level)
    if (logger === undefined) return
    try {
      if (level === 'fail' && typeof logger.error === 'function') logger.error(`${TAG}${line}`)
      else if (level === 'warn' && typeof logger.warn === 'function') logger.warn(`${TAG}${line}`)
      else if (typeof logger.info === 'function') logger.info(`${TAG}${line}`)
    } catch {
      // Best-effort mirror of a line that already reached the console.
    }
  }
}

/**
 * A sink with no context at all, for tests and pre-mount diagnostics.
 * @returns {(line: string, level?: string) => void} a console-only sink.
 */
export function consoleSink() {
  return (line, level = 'info') => writeConsole(line, level)
}

/**
 * Emit one line to the console.
 * @param {string} line - the message, without the tag.
 * @param {string} level - `info` | `ok` | `warn` | `fail` | `hint`.
 * @returns {void}
 */
function writeConsole(line, level) {
  try {
    // stderr for anything actionable, so `> log` and `> log 2>&1` both keep the
    // warnings apart from the inventory.
    if (level === 'warn' || level === 'fail') console.error(`${TAG}${line}`)
    else console.log(`${TAG}${line}`)
  } catch {
    // A closed stdout during shutdown is not a reason to abandon the report.
  }
}

/**
 * Resolve a cordis logger, tolerating a context that throws on lookup.
 * @param {object} [ctx] - cordis context.
 * @returns {object|undefined} a logger with at least one of info/warn/error.
 */
function resolveLogger(ctx) {
  try {
    if (typeof ctx?.logger === 'function') {
      const created = ctx.logger('selfcheck')
      if (created !== undefined && created !== null) return created
    }
    const service = typeof ctx?.get === 'function' ? ctx.get('logger') : undefined
    return typeof service?.info === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

/**
 * Render any thrown value as a single line.
 * @param {unknown} error - the thrown value.
 * @returns {string} a one-line message.
 */
export function message(error) {
  return error instanceof Error ? error.message : String(error)
}
