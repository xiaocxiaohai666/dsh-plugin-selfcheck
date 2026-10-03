/**
 * Tests for the plugin roster.
 *
 * The assertions that matter are the ones about attribution: a disabled row is
 * not a failure, a row with no fiber is, and a failure has to arrive with its
 * exception text rather than as a bare "something went wrong".
 *
 *   node tests/roster.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SELFCHECK_DIR = mkdtempSync(join(tmpdir(), 'dsh-selfcheck-roster-'))

const { collectRoster, renderRoster, flatten } = await import('../lib/roster.js')

/**
 * Build a stub context exposing a loader with the given rows.
 * @param {Array<{id: string, name: string, disabled?: boolean, mounted?: boolean}>} rows - desired rows.
 * @param {object} [options]
 * @param {boolean} [options.withGroup] - include a group row that must be filtered out.
 * @param {Function} [options.awaitFn] - overrides the loader's `await`.
 * @param {Function} [options.entriesFn] - overrides the loader's `entries`.
 * @returns {object} the stub context.
 */
function makeContext(rows, { withGroup = false, awaitFn, entriesFn } = {}) {
  const entries = rows.map(row => ({
    id: row.id,
    options: { id: row.id, name: row.name },
    disabled: row.disabled === true,
    fiber: row.mounted === false ? undefined : { uid: 1 },
  }))
  if (withGroup) {
    entries.push({ id: 'grp', options: { id: 'grp', name: '(group)', group: true }, disabled: false, fiber: { uid: 2 } })
  }
  const loader = {
    entries: entriesFn ?? (() => (function* () { for (const entry of entries) yield entry })()),
    ...awaitFn === undefined ? {} : { await: awaitFn },
  }
  return { get: key => (key === 'loader' ? loader : undefined) }
}

/** Text of every rendered line, for substring assertions. */
const textOf = roster => renderRoster(roster).map(line => line.text).join('\n')

// ------------------------------------------------------------- the three states
{
  const ctx = makeContext([
    { id: 'base', name: '@deepseek-ai/dsh-base' },
    { id: 'market', name: 'dshmarket' },
    { id: 'hmr', name: '@deepseek-ai/cordis-plugin-hmr', disabled: true },
    { id: 'broken', name: 'dsh-open-file', mounted: false },
  ], { withGroup: true })

  const roster = await collectRoster(ctx)
  assert.deepEqual(roster.counts, { ok: 2, skip: 1, fail: 1 })
  assert.deepEqual(roster.rows.map(row => row.state), ['ok', 'ok', 'skip', 'fail'])
  assert.equal(roster.rows.length, 4, 'group rows are not plugins')

  const text = textOf(roster)
  assert.match(text, /---- plugins: 2 mounted, 1 disabled, 1 failed/)
  assert.match(text, /---- problems:/)
  assert.match(text, /FAIL dsh-open-file/)
  assert.ok(!text.includes('(group)'), 'group rows are filtered out')
  console.log('states:', JSON.stringify(roster.counts))
}

// ------------------------------------------------- all healthy means no problem block
{
  const ctx = makeContext([{ id: 'a', name: 'plugin-a' }])
  const roster = await collectRoster(ctx)
  assert.equal(roster.counts.fail, 0)
  assert.ok(!textOf(roster).includes('---- problems:'))
}

// -------------------------------------------------- failures arrive with the WHY
{
  const root = new Error('Cannot find module "left-pad"')
  const aggregate = new AggregateError([
    new Error('failed to apply loader entry include:open-file (dsh-open-file): boom'),
    new Error('failed to import loader entry include:modlens (@liustack/modlens)', { cause: root }),
  ], 'loader fibers failed')

  const ctx = makeContext([{ id: 'a', name: 'plugin-a' }], { awaitFn: async () => { throw aggregate } })
  const roster = await collectRoster(ctx)

  assert.deepEqual(roster.errors, [
    'loader fibers failed',
    'failed to apply loader entry include:open-file (dsh-open-file): boom',
    'failed to import loader entry include:modlens (@liustack/modlens)',
    'Cannot find module "left-pad"',
  ], 'every wrapped message is unwrapped, innermost cause included')

  const text = textOf(roster)
  assert.match(text, /---- error details:/)
  assert.match(text, /dsh-open-file.*: boom/s)
  assert.match(text, /Cannot find module "left-pad"/, 'the root cause is shown, not just the wrapper')
  console.log('error capture:', roster.errors.length, 'messages unwrapped')
}

// ----------------------------------------------- an unsettled loader must not hang
{
  const ctx = makeContext([{ id: 'a', name: 'plugin-a' }], { awaitFn: () => new Promise(() => {}) })
  const started = Date.now()
  const roster = await collectRoster(ctx)
  // `EntryTree.await()` waits on every entry including the caller, so a deadlock
  // must cost only the error detail -- never the roster itself.
  assert.equal(roster.rows.length, 1, 'the roster is still produced')
  assert.equal(roster.counts.ok, 1)
  assert.equal(roster.errorsTimedOut, true)
  assert.deepEqual(roster.errors, [])
  assert.match(textOf(roster), /error details: unavailable/)
  console.log('unsettled loader: roster survived, errors timed out after', Date.now() - started, 'ms')
}

// ------------------------------------------------------------- degraded contexts
{
  const roster = await collectRoster({ get: () => undefined })
  assert.equal(roster.available, false)
  assert.match(textOf(roster), /loader service is not mounted/)
  console.log('no loader:', roster.reason)

  const throwing = await collectRoster({
    get: key => (key === 'loader' ? { entries() { throw new Error('tree exploded') } } : undefined),
  })
  assert.equal(throwing.rows.length, 0, 'a throwing tree reports as empty rather than crashing')
  assert.equal(throwing.available, true)
  assert.match(textOf(throwing), /no plugin rows found/)
  console.log('throwing loader survived')

  const hostile = await collectRoster({ get: () => { throw new Error('lookup exploded') } })
  assert.equal(hostile.available, false, 'a throwing ctx.get is reported, not propagated')
  console.log('hostile ctx survived')
}

// --------------------------------------------------------- flatten on odd inputs
{
  assert.deepEqual(flatten(new Error('plain')), ['plain'])
  assert.deepEqual(flatten('a string'), ['a string'])
  const cyclic = new Error('outer')
  cyclic.cause = cyclic
  assert.deepEqual(flatten(cyclic), ['outer'], 'a self-referential cause terminates')
}

console.log('\nroster: all assertions passed')
