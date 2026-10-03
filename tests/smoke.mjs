/**
 * Smoke test: mount the plugin against stub contexts and check it reports.
 *
 * This plugin is a diagnostic, so its most important property is that it mounts
 * and reports even when everything else is missing or broken. The cases below
 * are the degraded ones on purpose: no loader, a context whose lookups throw,
 * and finally a context with a real loader tree, which is the only case that may
 * write files.
 *
 *   node tests/smoke.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-selfcheck-smoke-'))
process.env.DSH_SELFCHECK_DIR = scratch

const mod = await import('../lib/index.js')
const { REPORT_PATH, REPORT_JSON_PATH, persistReport } = await import('../lib/report.js')

assert.equal(mod.name, 'selfcheck', 'the plugin id must match the bundle row')
assert.deepEqual(mod.inject, [], 'a diagnostic must not require any service to mount')
assert.equal(typeof mod.apply, 'function')

/**
 * Capture everything written to the console while `run` executes.
 * @param {Function} run - the body.
 * @returns {Promise<{value: unknown, printed: string}>} the result and the output.
 */
async function captureConsole(run) {
  const lines = []
  const log = console.log
  const error = console.error
  console.log = (...args) => lines.push(args.join(' '))
  console.error = (...args) => lines.push(args.join(' '))
  try {
    return { value: await run(), printed: lines.join('\n') }
  } finally {
    console.log = log
    console.error = error
  }
}

/**
 * Wait until `predicate` holds, or give up.
 * @param {Function} predicate - the condition.
 * @param {number} [budgetMs] - how long to wait.
 * @returns {Promise<boolean>} whether it held.
 */
async function until(predicate, budgetMs = 20_000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** A stub context exposing a loader with two rows. */
function loaderContext() {
  const entries = [
    { id: 'base', options: { id: 'base', name: '@deepseek-ai/dsh-base' }, disabled: false, fiber: { uid: 1 } },
    { id: 'hmr', options: { id: 'hmr', name: '@deepseek-ai/cordis-plugin-hmr' }, disabled: true, fiber: { uid: 2 } },
  ]
  return {
    get: key => (key === 'loader'
      ? { entries: () => (function* () { for (const e of entries) yield e })() }
      : undefined),
    inject: () => {},
  }
}

// ------------------------------------------------------- a bare, service-less ctx
{
  const { printed: out } = await captureConsole(async () => {
    mod.apply({ get: () => undefined, inject: () => {} })
    // The run is fire-and-forget; with no loader the settle loop returns at once
    // and only the checks take any time at all.
    await new Promise(resolve => setTimeout(resolve, 1000))
  })

  assert.match(out, /\[selfcheck\] plugin self-check/, 'the report reaches the console')
  assert.match(out, /loader service is not mounted/, 'the missing loader is named')
  assert.match(out, /---- install checks:/, 'the checks section is printed')
  for (const id of ['deps.version-drift', 'config.files', 'http.port', 'tools.registered']) {
    assert.ok(out.includes(id), `${id} is reported`)
  }
  assert.match(out, /---- selfcheck (OK|WARN|FAIL)/, 'the run ends with a verdict')
  assert.ok(!existsSync(REPORT_PATH), 'a loader-less run writes no files')
  console.log('bare ctx: report printed with', out.split('\n').length, 'lines, no files written')
}

// ------------------------------------------- a context whose lookups throw
{
  const ctx = {
    get baseUrl() { throw new Error('baseUrl exploded') },
    get: () => { throw new Error('lookup exploded') },
    inject: () => {},
  }
  const { printed } = await captureConsole(async () => {
    assert.doesNotThrow(() => mod.apply(ctx), 'apply must never throw')
    await new Promise(resolve => setTimeout(resolve, 800))
  })
  assert.ok(printed.includes('[selfcheck]'), 'it still reports')
  console.log('hostile ctx: apply() survived and reported')
}

// ------------------------------------------------------- a real loader tree
{
  const { printed } = await captureConsole(async () => {
    mod.apply(loaderContext())
    await until(() => existsSync(REPORT_PATH), 25_000)
  })

  assert.ok(existsSync(REPORT_PATH), 'a loaded run writes the text report')
  const text = readFileSync(REPORT_PATH, 'utf8')
  assert.match(text, /plugin self-check/)
  assert.match(text, /---- plugins: 1 mounted, 1 disabled, 0 failed/)
  assert.match(text, /---- selfcheck/)

  const json = JSON.parse(readFileSync(REPORT_JSON_PATH, 'utf8'))
  assert.equal(json.plugin, 'dsh-plugin-selfcheck')
  assert.ok(['ok', 'warn', 'fail'].includes(json.level))
  assert.equal(json.plugins.counts.ok, 1)
  assert.equal(json.plugins.counts.skip, 1)
  assert.equal(json.checks.length, 4)
  assert.equal(json.plugins.rows.length, 2)
  assert.ok(typeof json.ms === 'number')
  console.log('loader ctx:', printed.split('\n')[0], '| report files written')
}

// ------------------------------------------- a bare process must not pollute
{
  const before = readFileSync(REPORT_PATH, 'utf8')
  const written = persistReport({
    level: 'warn',
    ok: false,
    ms: 1,
    plugins: { available: false, rows: [], counts: { ok: 0, skip: 0, fail: 0 }, errors: [] },
    checks: [],
  })
  assert.deepEqual(written, { text: false, json: false }, 'a loader-less report is not persisted')
  assert.equal(readFileSync(REPORT_PATH, 'utf8'), before, 'the existing report is untouched')
  console.log('persist guard: loader-less reports are not written')
}

console.log('\nsmoke: all assertions passed')
