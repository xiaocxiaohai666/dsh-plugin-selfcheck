/**
 * Aggregation, rendering, and persistence of one self-check run.
 *
 * Kept apart from the collection code so the shape of a report is defined in one
 * place: the console output, the file on disk, and the value a model-facing tool
 * returns are all derived from the same object.
 * @module dsh-plugin-selfcheck/report
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { worstLevel } from './checks.js'
import { renderRoster } from './roster.js'

/**
 * Text copy of the last run, so a scrolled-away window can still be read.
 *
 * `DSH_HOME` is honoured because it is how dsh itself locates its home; the
 * fallback is the conventional `~/.dsh`. The path can be overridden outright for
 * tests, which must never overwrite a real report.
 */
export const REPORT_DIR = process.env.DSH_SELFCHECK_DIR ?? (process.env.DSH_HOME ?? join(homedir(), '.dsh'))

/** Text report of the last run. */
export const REPORT_PATH = join(REPORT_DIR, 'dsh-plugin-selfcheck.log')

/** Machine-readable report of the last run. */
export const REPORT_JSON_PATH = join(REPORT_DIR, 'dsh-plugin-selfcheck.json')

/**
 * Assemble a report.
 * @param {object} input
 * @param {object} input.roster - the collected roster.
 * @param {Array<object>} input.checks - the install checks.
 * @param {object} [input.host] - host fingerprint, when known.
 * @param {number} input.startedAt - `Date.now()` when the run began.
 * @returns {object} the report.
 */
export function buildReport({ roster, checks, host, startedAt }) {
  const installLevel = worstLevel(checks)
  const failures = roster.counts?.fail ?? 0
  const level = failures > 0 || installLevel === 'fail'
    ? 'fail'
    : installLevel === 'warn' ? 'warn' : 'ok'
  return {
    ok: level !== 'fail',
    level,
    plugin: 'dsh-plugin-selfcheck',
    ranAt: new Date().toISOString(),
    ms: Date.now() - startedAt,
    plugins: {
      available: roster.available,
      reason: roster.reason,
      counts: roster.counts,
      rows: (roster.rows ?? []).map(row => ({
        id: row.id,
        name: row.name,
        state: row.state,
        error: row.error,
      })),
      errors: roster.errors,
      errorsTimedOut: roster.errorsTimedOut,
    },
    checks,
    host: host ?? null,
  }
}

/**
 * Render a report as tagged lines.
 * @param {object} report - a built report.
 * @returns {Array<{text: string, level: string}>} the lines, without the tag.
 */
export function renderReport(report) {
  const lines = []
  lines.push({ text: ' plugin self-check', level: 'info' })
  for (const line of renderRoster({
    available: report.plugins.available,
    reason: report.plugins.reason,
    rows: report.plugins.rows,
    counts: report.plugins.counts,
    errors: report.plugins.errors,
    errorsTimedOut: report.plugins.errorsTimedOut,
  })) {
    lines.push(line)
  }

  lines.push({ text: '  ---- install checks:', level: 'info' })
  const width = report.checks.reduce((max, check) => Math.max(max, check.id.length), 0)
  const counts = { ok: 0, warn: 0, fail: 0 }
  for (const check of report.checks) {
    counts[check.level] += 1
    lines.push({ text: `  ${check.level.padEnd(4)} ${check.id.padEnd(width)}  ${check.detail}`, level: check.level })
    if (check.hint !== undefined) lines.push({ text: `         ${' '.repeat(width)}  -> ${check.hint}`, level: 'hint' })
    for (const extra of check.extra ?? []) lines.push({ text: `  ${' '.repeat(5 + width)}${extra}`, level: check.level === 'fail' ? 'fail' : 'info' })
  }

  lines.push({
    text: `  ---- selfcheck ${report.level.toUpperCase()} - ${report.plugins.counts.ok} mounted, ${report.plugins.counts.fail} failed`
      + `, checks ${counts.ok} ok / ${counts.warn} warn / ${counts.fail} fail (${report.ms}ms)`,
    level: report.ok ? 'info' : 'warn',
  })
  return lines
}

/**
 * Persist a report, text and JSON.
 *
 * Skipped when the roster was unavailable: a bare test process has no loader, and
 * letting it rewrite the real report would be the same pollution the empty
 * roster guard already prevents.
 * @param {object} report - a built report.
 * @returns {{text: boolean, json: boolean}} whether each file was written.
 */
export function persistReport(report) {
  if (report.plugins?.available !== true) return { text: false, json: false }
  const result = { text: false, json: false }
  try {
    mkdirSync(dirname(REPORT_PATH), { recursive: true })
    writeFileSync(REPORT_PATH, `${[...renderReport(report).map(line => line.text), ''].join('\n')}`, 'utf8')
    result.text = true
  } catch {
    // best-effort only
  }
  try {
    writeFileSync(REPORT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    result.json = true
  } catch {
    // best-effort only
  }
  return result
}
