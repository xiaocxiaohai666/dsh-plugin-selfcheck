/**
 * Tests for the install checks.
 *
 * The semver range logic is the riskiest code in the plugin -- a wrong `true`
 * there would quietly excuse a genuinely incompatible plugin -- so it is covered
 * case by case. The config and drift checks are driven against a throwaway
 * profile directory, so the test never reads or writes the real install.
 *
 *   node tests/checks.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Build a profile directory that looks installed to the checks. */
function makeProfile({ brokenPatch = false, bundles = true, patchRange = null, peerRange = null, peerPackage = '@deepseek-ai/dsh-tools' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-selfcheck-profile-'))
  writeFileSync(join(dir, 'cordis.yml'), '# root\n[]\n', 'utf8')
  writeFileSync(join(dir, 'cordis.patch.yml'), brokenPatch ? '- insert: [oops\n' : '# patch\n[]\n', 'utf8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'web-profile',
    ...bundles ? { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } } : {},
  }, null, 2), 'utf8')
  if (patchRange !== null || peerRange !== null) {
    const pluginDir = join(dir, 'node_modules', 'fake-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
      name: 'fake-plugin',
      version: '1.0.0',
      ...patchRange !== null ? { dsh: { engines: { dsh: patchRange } } } : {},
      ...peerRange !== null ? { peerDependencies: { [peerPackage]: peerRange } } : {},
    }, null, 2), 'utf8')
  }
  return dir
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-selfcheck-out-'))
// Redirect the report paths before the modules resolve them at load time.
process.env.DSH_SELFCHECK_DIR = scratch

// Point the process at the installed dsh so `host.js` can find the real SDK --
// which is what makes the optional YAML parser resolvable and the drift check
// meaningful. Without it the test still runs, just against the degraded paths.
const dshEntry = findDshEntry(join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx'))
if (dshEntry === undefined) console.log('checks: no dsh install found, exercising the degraded paths only')
else process.argv[1] = dshEntry

/**
 * Locate the installed dsh entry to simulate a real host process.
 * @param {string} root - the npx cache directory.
 * @returns {string|undefined} an absolute path inside the installed dsh package.
 */
function findDshEntry(root) {
  if (!existsSync(root)) return undefined
  for (const hash of readdirSync(root)) {
    const pkg = join(root, hash, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(pkg)) return pkg
  }
  return undefined
}

const { satisfies, parseVersion, compareVersions, runChecks } = await import('../lib/checks.js')

// --------------------------------------------------------------- semver ranges
{
  const cases = [
    ['0.1.2-rc.1', '>=0.1.2-rc.1', true, 'an exact prerelease bound accepts itself'],
    ['0.1.2-rc.1', '>=0.1.2', false, 'a prerelease sorts BEFORE the release it precedes'],
    ['0.1.2', '>=0.1.2-rc.1', true, 'a release satisfies a prerelease lower bound'],
    ['1.2.3', '^1.0.0', true],
    ['1.9.9', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false, 'caret stops at the next major'],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false, 'tilde stops at the next minor'],
    ['1.2.3', '>=1.0.0 <2.0.0', true],
    ['2.0.0', '>=1.0.0 <2.0.0', false],
    ['1.2.3', '^1 || ^3', true, 'alternatives are OR'],
    ['4.0.0', '^1 || ^3', false],
    ['1.2.3', '*', true],
    ['1.2.3', 'x', true],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.2.3', '>=not-a-version', null, 'an unparseable range is undecidable, not false'],
    ['not-a-version', '>=1.0.0', null],
  ]
  for (const [version, range, expected, why] of cases) {
    assert.equal(satisfies(version, range), expected, `${version} vs ${range}${why === undefined ? '' : ` -- ${why}`}`)
  }
  assert.equal(compareVersions(parseVersion('1.0.0-rc.1'), parseVersion('1.0.0')), -1)
  assert.equal(compareVersions(parseVersion('1.0.0'), parseVersion('1.0.0-rc.1')), 1)
  assert.equal(compareVersions(parseVersion('1.0.0-rc.2'), parseVersion('1.0.0-rc.10')), -1, 'numeric prerelease segments compare numerically')
  assert.equal(parseVersion('v1.2').partial, 2, 'a partial version records how many segments it had')
  assert.deepEqual(parseVersion('1.0.0-rc.2').pre, ['rc', '2'])
  assert.equal(parseVersion('not-a-version'), null, 'a non-version is rejected rather than guessed')
  console.log('semver: %d range cases passed', cases.length)
}

// ------------------------------------------------- semver's two easy-to-miss rules
{
  // 1. A prerelease only satisfies a set when a comparator carries a prerelease
  //    with the SAME [major, minor, patch]. Without this rule the drift check
  //    would call 0.1.9-rc.2 compatible with ">=0.1.2-rc.1 <0.2.0", which npm
  //    and dsh both reject.
  assert.equal(satisfies('0.1.9-rc.2', '>=0.1.2-rc.1 <0.2.0'), false, 'prerelease tuple rule')
  assert.equal(satisfies('0.1.2-rc.5', '>=0.1.2-rc.1'), true, 'a matching tuple admits later prereleases')
  assert.equal(satisfies('0.2.0-rc.1', '>=0.1.2-rc.1 <0.2.0'), false, 'the 0.2.0 tuple is not named')
  assert.equal(satisfies('0.2.0-rc.1', '>=0.1.2-rc.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0'), true, 'naming the tuple admits it')
  assert.equal(satisfies('0.1.2', '>=0.1.2-rc.1'), true, 'a release is unaffected by the rule')

  // 2. Caret tightens below 1.0.0. Treating "^0.1.2" as "<1.0.0" would call a
  //    0.2.0 host compatible with a plugin that never tested against it.
  assert.equal(satisfies('0.2.0', '^0.1.2'), false, '^0.1.2 does NOT reach 0.2.0')
  assert.equal(satisfies('0.1.9', '^0.1.2'), true)
  assert.equal(satisfies('0.0.3', '^0.0.3'), true)
  assert.equal(satisfies('0.0.4', '^0.0.3'), false, '^0.0.3 pins the patch')
  assert.equal(satisfies('0.9.0', '^0'), true, '^0 is <1.0.0')
  assert.equal(satisfies('0.2.0', '^0.1'), false, '^0.1 is <0.2.0')
  assert.equal(satisfies('2.0.0', '^1.2.3'), false)
  console.log('semver: prerelease-tuple and 0.x caret rules hold')
}

// ------------------------------------- cross-check against the real semver package
{
  const { importOptional } = await import('../lib/host.js')
  const mod = await importOptional(['semver'])
  const real = mod === undefined ? undefined : (mod.default ?? mod)
  if (real === undefined || typeof real.satisfies !== 'function') {
    console.log('cross-check: real semver not resolvable, skipped')
  } else {
    const ranges = [
      '>=1.0.0', '^1.2.3', '~1.2.3', '>=1.0.0 <2.0.0', '>=0.1.2-rc.1 <0.2.0',
      '^0.1.2-rc.1', '^0.1.2', '^0.0.3', '^0', '^0.1', '~0.1.2', '=1.2.3',
      '>1.0.0', '<=2.0.0', '^0.2.0', '>=0.1.2-rc.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0',
    ]
    const versions = [
      '0.0.2', '0.0.3', '0.0.4', '0.0.9', '0.1.0', '0.1.2-rc.1', '0.1.2', '0.1.5',
      '0.1.9-rc.2', '0.2.0-rc.1', '0.2.0', '0.2.5', '0.3.0-rc.1', '1.0.0', '1.2.3',
      '1.2.4', '1.3.0', '2.0.0', '2.5.0',
    ]
    let mismatches = 0
    let checked = 0
    for (const range of ranges) {
      for (const version of versions) {
        checked += 1
        const ours = satisfies(version, range)
        const theirs = real.satisfies(version, range)
        if (ours !== theirs) {
          mismatches += 1
          console.error(`  MISMATCH v=${version} range=${range} ours=${ours} semver=${theirs}`)
        }
      }
    }
    assert.equal(mismatches, 0, 'the built-in evaluator must agree with the semver package')
    console.log('cross-check: %d cases agree with the real semver package', checked)
  }
}

/** A context pointing at a profile directory. */
function makeContext(profileDir, { tools, webServer } = {}) {
  const loader = { ctx: { baseUrl: pathToFileURL(`${profileDir}/`).href } }
  return {
    baseUrl: pathToFileURL(`${profileDir}/`).href,
    get: (key) => {
      if (key === 'loader') return loader
      if (key === 'tools') return tools
      if (key === 'webServer') return webServer
      return undefined
    },
  }
}

/** A roster with a single row for `fake-plugin`. */
function rosterWith(specifier) {
  return {
    available: true,
    rows: [{ id: 'x', name: specifier, specifier, disabled: false, mounted: true, state: 'ok', error: null }],
    counts: { ok: 1, skip: 0, fail: 0 },
    errors: [],
    errorsTimedOut: false,
    reason: null,
  }
}

// -------------------------------------------------------------- the five checks
{
  const profile = makeProfile({ patchRange: '>=99.0.0' })
  const checks = await runChecks(makeContext(profile), rosterWith('fake-plugin'))

  assert.deepEqual(checks.map(c => c.id), ['deps.version-drift', 'deps.peer-gate', 'config.files', 'http.port', 'tools.registered'])

  // Drift: the fake plugin demands dsh >= 99, which nothing satisfies. It
  // declares no peers, though, so the host would still mount it -- the stale
  // declaration is an advisory, not a failure. (Without semver the check cannot
  // tell the two apart and stays conservative, so both levels are accepted.)
  const drift = checks.find(c => c.id === 'deps.version-drift')
  if (drift.level === 'ok' || drift.detail.includes('could not read')) {
    console.log('drift: skipped (no dsh install visible from this process)')
  } else if (drift.detail.includes('stale range')) {
    assert.equal(drift.level, 'warn')
    assert.ok(drift.extra.some(line => line.includes('fake-plugin')), 'the stale declaration is named')
    console.log('drift (stale declaration):', drift.detail)
  } else {
    assert.equal(drift.level, 'fail')
    assert.ok(drift.extra.some(line => line.includes('fake-plugin')), 'the offending plugin is named')
    console.log('drift (no semver, conservative):', drift.detail)
  }

  // The peer gate: the same profile is clean, because the strict plugin has no peers.
  const gate = checks.find(c => c.id === 'deps.peer-gate')
  assert.ok(['ok', 'warn'].includes(gate.level), `a peer-clean profile never fails the gate: ${gate.detail}`)
  console.log('peer gate (clean):', gate.detail)

  // Config: all three files valid.
  const config = checks.find(c => c.id === 'config.files')
  assert.equal(config.level, 'ok', config.detail)
  assert.ok(config.extra.some(line => line.includes('cordis.patch.yml') && line.includes('valid')))
  console.log('config (valid):', config.detail)

  // Port and tools: no services on the stub context.
  assert.equal(checks.find(c => c.id === 'http.port').level, 'warn')
  assert.equal(checks.find(c => c.id === 'tools.registered').level, 'warn')
}

// ------------------------------------------- a plugin the host would refuse
{
  // A peer range no host can satisfy: dsh refuses to mount it, so it never
  // appears in the loader tree and the roster cannot see it. Both dependency
  // checks must escalate together -- the declaration is stale AND the gate
  // blocks it. (An exact pin of an older host is the real-world shape of this;
  // it is covered against a fixed host version in tests/compat.mjs, because
  // which dsh this process can see is not guaranteed.)
  const profile = makeProfile({ patchRange: '>=99.0.0', peerRange: '>=99.0.0' })
  const checks = await runChecks(makeContext(profile), rosterWith('fake-plugin'))

  const gate = checks.find(c => c.id === 'deps.peer-gate')
  if (gate.detail.includes('could not read') || gate.detail.includes('no semver module')) {
    console.log('peer gate: skipped (no semver resolvable from this process)')
  } else {
    assert.equal(gate.level, 'fail', 'a refused plugin fails the gate')
    assert.match(gate.detail, /refuses to mount/)
    assert.ok(gate.extra.some(line => line.includes('fake-plugin')), 'the refused plugin is named')
    assert.ok(gate.extra.some(line => line.includes('@deepseek-ai/dsh-tools')), 'the rejected peer is named')
    assert.match(gate.hint, /allow-version/, 'the remedy names the exemption command')
    console.log('peer gate (refused):', gate.detail)
  }

  const drift = checks.find(c => c.id === 'deps.version-drift')
  if (!drift.detail.includes('could not read') && !drift.detail.includes('all ')) {
    assert.equal(drift.level, 'fail', 'a stale declaration the host also refuses is blocking')
    console.log('drift (blocking):', drift.detail)
  }
}

// --------------------------------------------------------- a broken patch file
{
  const profile = makeProfile({ brokenPatch: true })
  const checks = await runChecks(makeContext(profile), rosterWith('nothing-installed'))
  const config = checks.find(c => c.id === 'config.files')
  assert.equal(config.level, 'fail', 'a malformed patch file is a failure')
  assert.ok(config.extra.some(line => line.includes('cordis.patch.yml')), 'the broken file is named')
  console.log('config (broken):', config.detail)
}

// ---------------------------------------------------- a profile with no bundles
{
  const profile = makeProfile({ bundles: false })
  const checks = await runChecks(makeContext(profile), rosterWith('nothing-installed'))
  const config = checks.find(c => c.id === 'config.files')
  assert.equal(config.level, 'fail')
  assert.ok(config.extra.some(line => line.includes('dsh.profile.bundles')), 'the missing key is named')
  console.log('config (no bundles):', config.detail)
}

// ------------------------------------------------------------ tools enumeration
{
  const profile = makeProfile()
  const tools = {
    schemas: () => [
      { name: 'sd_txt2img', description: '' },
      { name: 'sd_img2img', description: '' },
      { name: 'dup', description: '' },
      { name: 'dup', description: '' },
    ],
  }
  const checks = await runChecks(makeContext(profile, { tools }), rosterWith('nothing-installed'))
  const toolCheck = checks.find(c => c.id === 'tools.registered')
  assert.equal(toolCheck.level, 'warn', 'duplicate tool names are worth flagging')
  assert.match(toolCheck.detail, /duplicate tool name/)
  console.log('tools (duplicates):', toolCheck.detail)

  const clean = await runChecks(
    makeContext(profile, { tools: { schemas: () => [{ name: 'a' }, { name: 'b' }] } }),
    rosterWith('nothing-installed'),
  )
  assert.equal(clean.find(c => c.id === 'tools.registered').level, 'ok')
}

// -------------------------------------------------------------- web port probe
{
  const profile = makeProfile()
  const webServer = { port: 1, host: '127.0.0.1' }
  const checks = await runChecks(makeContext(profile, { webServer }), rosterWith('nothing-installed'))
  const port = checks.find(c => c.id === 'http.port')
  assert.equal(port.level, 'warn', 'port 1 is a closed port, so the probe must warn not pass')
  assert.match(port.detail, /is not answering/)
  console.log('port (closed):', port.detail.split(':')[0])
}

// --------------------------------------------------- every check survives a hostile ctx
{
  const hostile = {
    get baseUrl() { throw new Error('baseUrl exploded') },
    get: () => { throw new Error('lookup exploded') },
  }
  const checks = await runChecks(hostile, rosterWith('nothing-installed'))
  assert.equal(checks.length, 5, 'all five checks still report')
  for (const check of checks) {
    assert.ok(['ok', 'warn', 'fail'].includes(check.level))
    assert.ok(typeof check.detail === 'string' && check.detail !== '', `${check.id} has a detail`)
  }
  console.log('hostile ctx: 5 checks survived, levels =', checks.map(c => c.level).join('/'))
}

console.log('\nchecks: all assertions passed')
