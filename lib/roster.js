/**
 * The plugin roster: every row in the host's loader tree, with its state and —
 * when it failed — the exception that stopped it.
 *
 * Why this needs a plugin at all: cordis already ships `Loader.showLog()`, which
 * prints `apply plugin <name>`. Two things defeat it. It is gated behind
 * `entry.parent.tree.enableLogs`, which defaults to false and has no CLI flag;
 * and it writes through `ctx.root.logger`, which the dsh CLI does not surface.
 * So a roster a human can actually see has to be written to `console` from
 * inside the host process.
 *
 * Nothing here is specific to any particular plugin: the rows come from
 * `ctx.loader.entries()`, so it reports whatever the user has installed.
 * @module dsh-plugin-selfcheck/roster
 */
import { message } from './log.js'

/** How long to wait for the tree to settle before reporting what is there. */
const SETTLE_BUDGET_MS = 15_000

/** Gap between stability samples. */
const POLL_MS = 300

/** Consecutive unchanged samples required to call the tree settled. */
const STABLE_SAMPLES = 3

/** How long the error probe may take before it is abandoned. */
const ERROR_PROBE_MS = 4000

/** Sentinel distinguishing a timed-out probe from a real (null) outcome. */
const TIMED_OUT = Symbol('timed-out')

/** Row states, in severity order. */
export const STATE = { OK: 'ok', SKIP: 'skip', FAIL: 'fail' }

/**
 * Resolve the loader service, tolerating a context that throws on lookup.
 * @param {object} ctx - cordis context.
 * @returns {object|undefined} the loader, or undefined.
 */
export function resolveLoader(ctx) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('loader') : undefined
    if (service !== undefined && service !== null) return service
  } catch {
    // fall through to the property form
  }
  try {
    return ctx?.loader ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Collect the roster.
 * @param {object} ctx - cordis context.
 * @returns {Promise<object>} `{ available, rows, counts, errors, errorsTimedOut, reason }`.
 */
export async function collectRoster(ctx) {
  const loader = resolveLoader(ctx)
  if (loader === undefined) {
    return {
      available: false,
      rows: [],
      counts: { ok: 0, skip: 0, fail: 0 },
      errors: [],
      errorsTimedOut: false,
      reason: 'the loader service is not mounted',
    }
  }

  await settle(loader)

  const rows = []
  for (const entry of iterate(loader)) {
    if (entry?.options?.group === true) continue
    rows.push({
      id: String(entry?.id ?? ''),
      name: String(entry?.options?.name ?? '(unnamed)'),
      specifier: String(entry?.options?.name ?? ''),
      disabled: entry?.disabled === true,
      mounted: Boolean(entry?.fiber),
      error: readFiberError(entry),
    })
  }
  for (const row of rows) row.state = stateOf(row)

  const problems = await probeErrors(loader)
  const counts = { ok: 0, skip: 0, fail: 0 }
  for (const row of rows) counts[row.state] += 1

  return { available: true, rows, counts, errors: problems.messages, errorsTimedOut: problems.timedOut, reason: null }
}

/**
 * The state of one row.
 *
 * Three states only, and `disabled` is deliberately not a failure: a row the
 * user turned off is working as intended.
 * @param {object} row - a built row.
 * @returns {string} one of `STATE`.
 */
function stateOf(row) {
  if (row.disabled) return STATE.SKIP
  return row.mounted ? STATE.OK : STATE.FAIL
}

/**
 * Sample the tree until its size stops changing.
 *
 * `EntryTree.await()` is deliberately NOT used: it waits for every entry
 * including the one calling it, which deadlocks from inside a plugin. Watching
 * the entry count settle is the safe equivalent.
 * @param {object} loader - the loader service.
 * @returns {Promise<void>} resolves once the tree looks stable.
 */
async function settle(loader) {
  let lastSize = -1
  let stable = 0
  const deadline = Date.now() + SETTLE_BUDGET_MS
  for (;;) {
    const size = countEntries(loader)
    if (size === lastSize) stable += 1
    else stable = 0
    lastSize = size
    if (stable >= STABLE_SAMPLES || Date.now() > deadline) return
    await delay(POLL_MS)
  }
}

/**
 * Count entries without allocating the full list.
 * @param {object} loader - the loader service.
 * @returns {number} entry count.
 */
function countEntries(loader) {
  let count = 0
  for (const _ of iterate(loader)) count += 1
  return count
}

/**
 * Iterate the loader's entries defensively.
 * @param {object} loader - the loader service.
 * @returns {Iterable<object>} the entries (empty when the API is unavailable).
 */
function* iterate(loader) {
  try {
    const entries = loader?.entries?.()
    if (entries === undefined || entries === null) return
    for (const entry of entries) yield entry
  } catch {
    // A tree that throws while enumerating is reported as an empty one.
  }
}

/**
 * Ask the loader for the failures it collected.
 *
 * `EntryTree.await()` is the only API that surfaces mount errors: it rethrows the
 * settled fiber failure, or an `AggregateError` when several rows failed. Each
 * reason is already formatted as
 * `failed to apply loader entry <id> (<name>): <original message>`.
 *
 * Two guards, because this call is not entirely safe from inside a plugin: it is
 * bounded by a timeout (it waits on every entry including the caller), and it
 * runs after the roster has been built, so a stalled probe can never delay or
 * suppress the list itself.
 * @param {object} loader - the loader service.
 * @returns {Promise<{messages: string[], timedOut: boolean}>} the failure texts.
 */
async function probeErrors(loader) {
  if (typeof loader?.await !== 'function') return { messages: [], timedOut: false }
  let timer = null
  try {
    const expiry = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ERROR_PROBE_MS)
    })
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => loader.await())
        .then(() => null, error => error),
      expiry,
    ])
    if (outcome === TIMED_OUT) return { messages: [], timedOut: true }
    if (outcome === null) return { messages: [], timedOut: false }
    return { messages: flatten(outcome), timedOut: false }
  } catch (error) {
    return { messages: [message(error)], timedOut: false }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * Flatten an error and everything wrapped inside it into readable lines.
 * @param {unknown} error - the thrown value (often an AggregateError).
 * @returns {string[]} one line per distinct message.
 */
export function flatten(error) {
  const parts = []
  const seen = new Set()
  const walk = (node, depth) => {
    if (node === null || node === undefined || depth > 4 || seen.has(node)) return
    seen.add(node)
    const text = node instanceof Error ? node.message : String(node)
    if (typeof text === 'string' && text.trim() !== '') parts.push(text.trim())
    const nested = Array.isArray(node?.errors) ? node.errors : node?.cause === undefined ? [] : [node.cause]
    for (const child of nested) walk(child, depth + 1)
  }
  walk(error, 0)
  return parts
}

/**
 * Read a fiber's stored failure without awaiting it.
 *
 * `fiber.await()` would be the documented way, but awaiting a fiber from inside
 * another plugin risks waiting on the caller itself. These fields are internal
 * (`_error` is underscore-private), so the read is strictly best-effort.
 * @param {object} entry - a loader entry.
 * @returns {string|null} the error message, or null.
 */
function readFiberError(entry) {
  try {
    const error = entry?.fiber?._error
    if (error instanceof Error) return error.message
    if (typeof error === 'string' && error !== '') return error
    return null
  } catch {
    return null
  }
}

/**
 * Render the roster as indented lines.
 * @param {object} roster - the value `collectRoster` resolved with.
 * @returns {Array<{text: string, level: string}>} the lines.
 */
export function renderRoster(roster) {
  const lines = []
  if (!roster.available) {
    lines.push({ text: `  ${roster.reason}`, level: 'warn' })
    return lines
  }
  if (roster.rows.length === 0) {
    lines.push({ text: '  no plugin rows found in the loader tree', level: 'warn' })
    return lines
  }

  const width = roster.rows.reduce((max, row) => Math.max(max, row.name.length), 0)
  for (const row of roster.rows) {
    const state = row.state === STATE.OK ? 'ok  ' : row.state === STATE.SKIP ? 'skip' : 'FAIL'
    const trailing = row.state === STATE.SKIP ? '(disabled)' : row.id
    lines.push({ text: `  ${state} ${row.name.padEnd(width)}  ${trailing}`, level: row.state === STATE.FAIL ? 'fail' : 'info' })
  }
  lines.push({
    text: `  ---- plugins: ${roster.counts.ok} mounted, ${roster.counts.skip} disabled, ${roster.counts.fail} failed`,
    level: 'info',
  })

  const broken = roster.rows.filter(row => row.state === STATE.FAIL)
  if (broken.length > 0) {
    lines.push({ text: '  ---- problems:', level: 'warn' })
    for (const row of broken) {
      lines.push({ text: `  FAIL ${row.name}  ${row.id}`, level: 'fail' })
      if (row.error !== null) {
        for (const part of splitLines(row.error)) lines.push({ text: `         ${part}`, level: 'fail' })
      }
    }
  }

  if (roster.errors.length > 0) {
    lines.push({ text: '  ---- error details:', level: 'warn' })
    for (const text of roster.errors) {
      for (const [index, part] of splitLines(text).entries()) {
        lines.push({ text: `  ${index === 0 ? '!' : ' '} ${part}`, level: 'fail' })
      }
    }
  } else if (roster.errorsTimedOut === true) {
    lines.push({ text: `  ---- error details: unavailable (the loader did not settle within ${ERROR_PROBE_MS}ms)`, level: 'warn' })
  }
  return lines
}

/**
 * Split a message into lines so a multi-line stack or aggregate stays readable.
 * @param {string} text - the message.
 * @returns {string[]} its lines.
 */
function splitLines(text) {
  return String(text).split(/\r?\n/).filter(line => line.trim() !== '')
}

/**
 * Sleep.
 * @param {number} ms - milliseconds.
 * @returns {Promise<void>} resolves after the delay.
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
