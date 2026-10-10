/**
 * Tests for the host compatibility model.
 *
 * The peer gate is the check that decides whether a plugin is missing because
 * the host REFUSED it, so a wrong verdict here either hides a broken install or
 * cries wolf on a healthy one. Both failure modes are expensive, so every branch
 * of the evaluation is covered case by case against a fixed runtime version.
 *
 * The expected values are not invented: each one was measured against the real
 * `semver` the host ships, with the same `includePrerelease` option the host
 * passes. The two entries that read as surprising are real behaviour, and they
 * are the reason this module does not use a plain `satisfies`:
 *
 *   - `>=0.1.7-rc.1` ACCEPTS `0.2.0-rc.2` under `includePrerelease`, although a
 *     default `satisfies` rejects it;
 *   - `>=0.1.0 <0.2.0` also accepts it, because the upper bound is evaluated in
 *     prerelease mode too.
 *
 *   node tests/compat.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

// Point the process at an installed dsh so `loadSemver()` can reach the host's
// `node_modules`. A miss is not fatal: the structural assertions still run.
const dshEntry = findDshEntry(join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx'))
if (dshEntry !== undefined) process.argv[1] = dshEntry

/**
 * Locate an installed dsh entry to simulate a real host process.
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

const {
  declaredBundles,
  evaluatePluginCompatibility,
  hostAccepts,
  isDshPeer,
  isExempted,
  loadSemver,
  readExemptions,
  requirementOf,
  satisfiesHost,
} = await import('../lib/compat.js')

const semver = await loadSemver()
const HOST = '0.2.0-rc.2'

// ------------------------------------------------------------- the peer filter
{
  assert.equal(isDshPeer('@deepseek-ai/dsh'), true, 'the runtime itself is gated')
  assert.equal(isDshPeer('@deepseek-ai/dsh-tools'), true)
  assert.equal(isDshPeer('@deepseek-ai/dsh-client-ui-chat'), true)
  assert.equal(isDshPeer('@deepseek-ai/cordis'), false, 'cordis is not a dsh-* package')
  assert.equal(isDshPeer('@deepseek-ai/schemastery'), false)
  assert.equal(isDshPeer('dshmarket'), false, 'a bare name is not gated')
  assert.equal(isDshPeer('react'), false)
  console.log('peer filter: only @deepseek-ai/dsh and @deepseek-ai/dsh-* are gated')
}

// ------------------------------------------------------- the workspace spellings
{
  for (const range of ['workspace:^', 'workspace:~', 'workspace:*']) {
    assert.equal(requirementOf(range, HOST), HOST, `${range} means the running runtime`)
  }
  assert.equal(requirementOf('^0.2.0-rc.1', HOST), '^0.2.0-rc.1', 'a real range is passed through')
  console.log('workspace ranges: resolved to the running runtime, not parsed')
}

// ----------------------------------------------------------- the range verdicts
if (semver === undefined) {
  console.log('semver ranges: SKIPPED (no semver resolvable from this process)')
} else {
  const cases = [
    ['0.1.2-rc.1', false, 'an exact pin of the OLD host is refused -- the dsh-open-file case'],
    ['>=0.1.7-rc.1', true, 'an open lower bound accepts a later prerelease under includePrerelease'],
    ['>=0.1.2-rc.1', true, 'same, from an older bound'],
    ['^0.1.2', false, 'caret below 0.2 stops at <0.2.0'],
    ['>=0.1.0 <0.2.0', true, 'the upper bound is prerelease-permissive too'],
    ['^0.2.0-rc.1', true],
    ['>=0.2.0-rc.2', true],
    ['>=0.1.2-rc.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0 || >=0.3.0-rc.1 <0.4.0', true, 'the plugin\'s own declaration'],
    ['1.0.0', false, 'a future major is refused'],
    ['', false, 'an empty range is a refusal, not a pass'],
    ['not a range', false, 'an unparsable range is a refusal'],
  ]
  for (const [range, expected, why] of cases) {
    assert.equal(satisfiesHost(range, HOST, semver), expected, `${range} vs ${HOST}${why === undefined ? '' : ` -- ${why}`}`)
  }
  console.log(`semver ranges: ${cases.length} cases, including the includePrerelease nuances`)
}

// ---------------------------------------------------------------- the manifests
if (semver === undefined) {
  console.log('manifest evaluation: SKIPPED (needs semver)')
} else {
  const refused = evaluatePluginCompatibility({
    name: 'pinned',
    version: '0.1.2-rc.1',
    peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.2-rc.1', '@deepseek-ai/cordis': '^4.0.1' },
  }, HOST, semver)
  assert.notEqual(refused, null, 'an exact pin is reported')
  assert.deepEqual(Object.keys(refused.peers), ['@deepseek-ai/dsh-tools'], 'only the dsh peer is named')
  assert.equal(refused.name, 'pinned')
  assert.equal(refused.version, '0.1.2-rc.1')

  const openBound = evaluatePluginCompatibility({
    name: 'open',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.2-rc.1' },
  }, HOST, semver)
  assert.equal(openBound, null, 'an open bound is accepted')

  const workspace = evaluatePluginCompatibility({
    name: 'ws',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh': 'workspace:*' },
  }, HOST, semver)
  assert.equal(workspace, null, 'workspace:* resolves to the runtime and is accepted')

  const nonDsh = evaluatePluginCompatibility({
    name: 'other',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/cordis': '^99.0.0', react: '^18' },
  }, HOST, semver)
  assert.equal(nonDsh, null, 'non-dsh peers are ignored, however wrong they look')

  assert.equal(evaluatePluginCompatibility({ name: 'none', version: '1.0.0' }, HOST, semver), null, 'no peerDependencies means no gate')
  assert.equal(evaluatePluginCompatibility(undefined, HOST, semver), null, 'an unreadable manifest is not an accusation')
  assert.equal(evaluatePluginCompatibility({ name: 'bad', version: '1.0.0', peerDependencies: ['nope'] }, HOST, semver), null, 'a malformed field is ignored rather than thrown')

  assert.equal(hostAccepts({ peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.2-rc.1' } }, HOST, semver), false)
  assert.equal(hostAccepts({ peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.2-rc.1' } }, HOST, semver), true)
  console.log('manifest evaluation: exact pins refused, open bounds and workspace ranges accepted')
}

// ----------------------------------------------------------------- the exemptions
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-selfcheck-compat-'))

  assert.deepEqual(readExemptions(dir), { exemptions: {}, warnings: [] }, 'a missing file means no exemptions')
  assert.deepEqual(readExemptions(null), { exemptions: {}, warnings: [] }, 'an unlocated profile means no exemptions')

  writeFileSync(join(dir, 'compatibility.json'), '{ not json', 'utf8')
  const broken = readExemptions(dir)
  assert.equal(broken.warnings.length, 1, 'a corrupt file warns instead of throwing')
  assert.deepEqual(broken.exemptions, {}, 'a corrupt file grants nothing')

  writeFileSync(join(dir, 'compatibility.json'), JSON.stringify({
    'pinned@0.1.2-rc.1': [HOST, '0.2.1'],
    'bad-key': [HOST],
    'also@1.0.0': 'not-a-list',
  }), 'utf8')
  const parsed = readExemptions(dir)
  assert.deepEqual(Object.keys(parsed.exemptions), ['pinned@0.1.2-rc.1'], 'only well-formed records survive')
  assert.equal(isExempted(parsed.exemptions, 'pinned@0.1.2-rc.1', HOST), true)
  assert.equal(isExempted(parsed.exemptions, 'pinned@0.1.2-rc.1', '0.3.0-rc.1'), false, 'an exemption is per exact runtime version')
  assert.equal(isExempted(parsed.exemptions, 'other@1.0.0', HOST), false)
  console.log('exemptions: corrupt files degrade to none, and grants are per exact version')
}

// ------------------------------------------------------------------- the bundles
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-selfcheck-bundles-'))
  assert.deepEqual(declaredBundles(dir), [], 'a missing manifest yields no candidates')
  assert.deepEqual(declaredBundles(null), [], 'an unlocated profile yields no candidates')

  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'web-profile',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'pinned', 42] } },
  }), 'utf8')
  assert.deepEqual(declaredBundles(dir), ['@deepseek-ai/dsh-base', 'pinned'], 'non-string entries are dropped')

  // The point of reading the manifest: a refused bundle is absent from the
  // loader tree, so it can only be found here.
  const nested = join(dir, 'node_modules', 'pinned')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'pinned', version: '0.1.2-rc.1' }), 'utf8')
  assert.ok(declaredBundles(dir).includes('pinned'), 'a skipped bundle is still a candidate')
  console.log('bundles: read from the profile manifest, so skipped bundles stay visible')
}

// ------------------------------------------------- the plugin's own declaration
if (semver !== undefined) {
  const own = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(evaluatePluginCompatibility(own, HOST, semver), null, 'this plugin accepts the host it targets')
  console.log('own manifest: accepts ' + HOST)
}

console.log('\ncompat: all assertions passed')
