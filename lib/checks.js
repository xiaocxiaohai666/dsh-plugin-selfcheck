/**
 * The four install-level checks, run alongside the roster.
 *
 * Each one answers a question the roster cannot: whether the installed pieces
 * still agree with each other (version drift, config validity), whether the host
 * is actually serving (port and route), and what the install contributes to the
 * model (registered tools).
 *
 * Rules shared by every check here:
 *  - no network access beyond loopback, and no assumption that any optional
 *    service or library is present;
 *  - a check that cannot decide reports `warn` with the reason, never a silent
 *    pass and never a throw;
 *  - nothing is hard-coded to a particular machine: every path is derived from
 *    the running host, so the plugin reports the USER's install, not the
 *    author's.
 * @module dsh-plugin-selfcheck/checks
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findInstalledPackage, importOptional, installedRoots, packageNameOf, profileDir } from './host.js'
import { message } from './log.js'

/** Severity order used to pick a section's overall level. */
const LEVELS = ['ok', 'warn', 'fail']

/** How long a loopback probe may take. */
const PROBE_TIMEOUT_MS = 3000

/**
 * Run every check.
 * @param {object} ctx - cordis context.
 * @param {object} roster - the collected roster (used for the drift scan).
 * @returns {Promise<Array<object>>} the checks, each `{ id, level, detail, hint?, extra? }`.
 */
export async function runChecks(ctx, roster) {
  // Looked up through the guarded helper: `ctx.get` can THROW on a partially
  // torn-down container, not merely return undefined, and an unguarded call here
  // would take every check down with it.
  const roots = installedRoots(ctx, lookupService(ctx, 'loader'))
  const results = []
  // Sequential on purpose: these are diagnostics, they run once, and serialising
  // them keeps a slow probe from interleaving its output with a fast one.
  results.push(await guard('deps.version-drift', () => checkVersionDrift(roster, roots)))
  results.push(await guard('config.files', () => checkProfileConfig(ctx)))
  results.push(await guard('http.port', () => checkWebPort(ctx)))
  results.push(await guard('tools.registered', () => checkTools(ctx)))
  return results
}

/**
 * Run one check, converting any throw into a `warn`.
 *
 * A check that can fail the boot is worse than no check, so nothing thrown here
 * is ever propagated.
 * @param {string} id - the check id, for the failure message.
 * @param {Function} run - the check body.
 * @returns {Promise<object>} the check result.
 */
async function guard(id, run) {
  try {
    return await run()
  } catch (error) {
    return warn(id, `the check itself failed: ${message(error)}`, 'treat this install as unverified')
  }
}

// ---------------------------------------------------------------- version drift

/**
 * Compare each plugin's declared host range against the installed dsh version.
 *
 * This is the check that catches "the host was upgraded and a plugin's
 * assumption is now stale" before it shows up as a mysterious misbehaviour.
 * @param {object} roster - the collected roster.
 * @returns {object} the check result.
 */
function checkVersionDrift(roster, roots) {
  const host = findInstalledPackage('@deepseek-ai/dsh', roots)
  const hostVersion = typeof host?.manifest?.version === 'string' ? host.manifest.version : null
  if (hostVersion === null) {
    return warn('deps.version-drift', 'could not read the installed dsh version', 'version drift cannot be evaluated on this install')
  }

  const undecidable = []
  const drifting = []
  let scanned = 0

  const seen = new Set()
  for (const row of roster.rows ?? []) {
    const name = packageNameOf(row.specifier)
    if (name === null || seen.has(name)) continue
    seen.add(name)
    const found = findInstalledPackage(name, roots)
    const range = found?.manifest?.dsh?.engines?.dsh
    if (typeof range !== 'string' || range.trim() === '') continue
    scanned += 1
    const ok = satisfies(hostVersion, range)
    if (ok === null) undecidable.push(`${name} declares "${range}" (unsupported syntax)`)
    else if (!ok) drifting.push(`${name} declares "${range}" but the host is ${hostVersion}`)
  }

  const extra = [...drifting.map(t => `  ! ${t}`), ...undecidable.map(t => `  ? ${t}`)]
  if (drifting.length > 0) {
    return fail(
      'deps.version-drift',
      `${drifting.length} of ${scanned} plugins do not accept the installed dsh ${hostVersion}`,
      'upgrade or replace those plugins, or pin dsh back to a version they accept',
      extra,
    )
  }
  if (undecidable.length > 0) {
    return warn('deps.version-drift', `${undecidable.length} of ${scanned} plugins declare a range this check cannot parse`, 'verify those by hand', extra)
  }
  return ok('deps.version-drift', `all ${scanned} plugins declaring dsh.engines.dsh accept ${hostVersion}${host ? ` (${host.root})` : ''}`)
}

/**
 * Whether a version satisfies a range.
 *
 * Deliberately a small subset: `||` alternatives of space-separated comparators
 * using `>=`, `>`, `<=`, `<`, `=`, `^`, `~`, and bare versions. Anything else
 * returns null -- "cannot decide" is a useful answer, a wrong `true` is not.
 * @param {string} version - the concrete version, e.g. `0.1.2-rc.1`.
 * @param {string} range - the declared range.
 * @returns {boolean|null} true, false, or null when the range is unsupported.
 */
export function satisfies(version, range) {
  const target = parseVersion(version)
  if (target === null) return null
  const alternatives = String(range).split('||')
  let decided = false
  for (const alternative of alternatives) {
    const result = satisfiesAll(target, alternative.trim().split(/\s+/).filter(Boolean))
    if (result === null) return null
    if (result) decided = true
  }
  return decided
}

/**
 * Whether a version satisfies every comparator in one alternative.
 *
 * This is where semver's prerelease rule lives, and it is not optional: a
 * prerelease version only satisfies a comparator set if one of the comparators
 * carries a prerelease with the **same `[major, minor, patch]` tuple**. Without
 * it, `>=0.1.2-rc.1 <0.2.0` would accept `0.1.9-rc.2`, which npm and dsh both
 * reject -- a false "ok" from the one check whose entire job is catching
 * incompatibility. Cross-checked against the real `semver` package.
 * @param {object} target - the parsed version.
 * @param {string[]} comparators - e.g. `['>=1.0.0', '<2.0.0']`.
 * @returns {boolean|null} true, false, or null when unsupported.
 */
function satisfiesAll(target, comparators) {
  if (comparators.length === 0) return true

  if (target.pre.length > 0) {
    let admitsPrerelease = false
    for (const comparator of comparators) {
      const bound = comparatorBound(comparator)
      if (bound === null) return null
      if (bound.pre.length > 0
        && bound.major === target.major
        && bound.minor === target.minor
        && bound.patch === target.patch) {
        admitsPrerelease = true
        break
      }
    }
    if (!admitsPrerelease) return false
  }

  for (const comparator of comparators) {
    const result = satisfiesOne(target, comparator)
    if (result === null) return null
    if (!result) return false
  }
  return true
}

/**
 * Parse the version a comparator names.
 * @param {string} comparator - e.g. `>=1.2.3`, `^1.0.0`, `*`.
 * @returns {object|null} the parsed version, or null when there is none or it is unparseable.
 */
function comparatorBound(comparator) {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*v?(.+)$/.exec(comparator)
  if (match === null) return null
  const raw = match[2]
  if (raw === '*' || raw.toLowerCase() === 'x') return null
  return parseVersion(raw)
}

/**
 * Whether a version satisfies one comparator.
 * @param {object} target - the parsed version.
 * @param {string} comparator - e.g. `^1.2.3`.
 * @returns {boolean|null} true, false, or null when unsupported.
 */
function satisfiesOne(target, comparator) {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*v?(.+)$/.exec(comparator)
  if (match === null) return null
  const operator = match[1] ?? '='
  const raw = match[2]

  if (raw === '*' || raw.toLowerCase() === 'x') return true

  const bound = parseVersion(raw)
  if (bound === null) return null
  const cmp = compareVersions(target, bound)

  if (operator === '=') {
    // A partial version (`=1.2`) is a range, not an exact pin.
    if (bound.partial === 0) return cmp === 0
    if (bound.partial === 1) return target.major === bound.major
    if (bound.partial === 2) return target.major === bound.major && target.minor === bound.minor
    return cmp === 0
  }
  if (operator === '>=') return cmp >= 0
  if (operator === '>') return cmp > 0
  if (operator === '<=') return cmp <= 0
  if (operator === '<') return cmp < 0

  // ^x.y.z -> >=x.y.z <(x+1).0.0 ; ~x.y.z -> >=x.y.z <x.(y+1).0
  if (cmp < 0) return false
  const ceiling = operator === '^' ? caretCeiling(bound) : { major: bound.major, minor: bound.minor + 1, patch: 0 }
  return compareVersions(target, { ...ceiling, pre: [], partial: 3 }) < 0
}

/**
 * The exclusive upper bound a caret range implies.
 *
 * Caret tightens below 1.0.0, and getting this wrong is a silent
 * false-compatible: `^0.1.2` means `<0.2.0`, NOT `<1.0.0`, so treating it as the
 * latter would call a 0.2.0 host compatible with a plugin that never tested
 * against it. How far it tightens depends on how many segments were written:
 * `^0` is `<1.0.0`, `^0.1` is `<0.2.0`, `^0.1.2` is `<0.2.0`, `^0.0.3` is `<0.0.4`.
 * Matches the real `semver` package across the cross-check suite.
 * @param {object} bound - the parsed version the caret was written against.
 * @returns {{major: number, minor: number, patch: number}} the exclusive ceiling.
 */
function caretCeiling(bound) {
  if (bound.partial === 1) return { major: bound.major + 1, minor: 0, patch: 0 }
  if (bound.partial === 2) {
    return bound.major === 0
      ? { major: 0, minor: bound.minor + 1, patch: 0 }
      : { major: bound.major + 1, minor: 0, patch: 0 }
  }
  if (bound.major > 0) return { major: bound.major + 1, minor: 0, patch: 0 }
  if (bound.minor > 0) return { major: 0, minor: bound.minor + 1, patch: 0 }
  return { major: 0, minor: 0, patch: bound.patch + 1 }
}

/**
 * Parse a version string into comparable parts.
 * @param {string} value - e.g. `0.1.2-rc.1`.
 * @returns {{major: number, minor: number, patch: number, pre: string[], partial: number}|null} the parsed version.
 */
export function parseVersion(value) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(String(value).trim())
  if (match === null) return null
  const parts = [match[1], match[2], match[3]].filter(part => part !== undefined)
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
    partial: parts.length,
  }
}

/**
 * Compare two parsed versions.
 * @param {object} a - left version.
 * @param {object} b - right version.
 * @returns {number} -1, 0, or 1.
 */
export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  // A prerelease sorts before the release it precedes: 1.0.0-rc.1 < 1.0.0.
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < length; index++) {
    const left = a.pre[index]
    const right = b.pre[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }
  return 0
}

// ------------------------------------------------------------------- config

/**
 * Validate the profile's own configuration files.
 *
 * A malformed patch file is the classic silent failure: the profile still boots,
 * minus the plugin you thought you had configured.
 * @param {object} ctx - cordis context.
 * @returns {Promise<object>} the check result.
 */
async function checkProfileConfig(ctx) {
  const dir = profileDir(ctx, ctx?.get?.('loader'))
  if (dir === null) {
    return warn('config.files', 'could not locate the profile directory', 'the loader context did not expose baseUrl')
  }

  const yaml = await loadYaml()
  const extra = []
  let problems = 0
  let checked = 0

  for (const name of ['cordis.yml', 'cordis.patch.yml']) {
    const path = join(dir, name)
    if (!existsSync(path)) {
      extra.push(`  ? ${name}: not present`)
      continue
    }
    checked += 1
    const text = readText(path)
    if (text === null) {
      problems += 1
      extra.push(`  ! ${name}: unreadable`)
      continue
    }
    if (text.trim() === '') {
      extra.push(`  ? ${name}: empty`)
      continue
    }
    if (yaml === null) {
      // Structural fallback: the loader requires a top-level array.
      if (!/^\s*(\[\]|-)/m.test(text)) {
        problems += 1
        extra.push(`  ! ${name}: does not look like a top-level array (no parser available to confirm)`)
      } else {
        extra.push(`  ~ ${name}: looks like an array (no YAML parser available for a full parse)`)
      }
      continue
    }
    // The parser throw is the single most likely real finding here, so it is
    // caught per file and reported as a problem WITH THAT FILE -- letting it
    // escape to the outer guard would collapse it into a useless "the check
    // itself failed".
    let parsed
    try {
      parsed = yaml.parse(text)
    } catch (error) {
      problems += 1
      extra.push(`  ! ${name}: does not parse -- ${message(error).split('\n')[0]}`)
      continue
    }
    if (parsed === undefined || parsed === null) {
      problems += 1
      extra.push(`  ! ${name}: parsed to nothing`)
    } else if (!Array.isArray(parsed)) {
      problems += 1
      extra.push(`  ! ${name}: top level is ${typeof parsed}, the loader requires an array`)
    } else {
      extra.push(`  + ${name}: valid array (${parsed.length} entries)`)
    }
  }

  const manifestPath = join(dir, 'package.json')
  if (existsSync(manifestPath)) {
    checked += 1
    const manifest = safeJson(readText(manifestPath))
    if (manifest === undefined) {
      problems += 1
      extra.push('  ! package.json: not valid JSON')
    } else {
      const bundles = manifest?.dsh?.profile?.bundles
      if (Array.isArray(bundles)) extra.push(`  + package.json: valid, ${bundles.length} bundles declared`)
      else {
        problems += 1
        extra.push('  ! package.json: dsh.profile.bundles is missing or not an array')
      }
    }
  }

  const base = `${dir} (${checked} files checked${yaml === null ? ', no YAML parser' : ''})`
  if (problems > 0) {
    return fail('config.files', `${problems} problem(s) in ${base}`, 'fix the listed file(s); a malformed patch silently drops plugins', extra)
  }
  return ok('config.files', base, extra)
}

/**
 * Load a YAML parser, if the host ships one.
 * @returns {Promise<{parse: Function}|null>} a `parse(text)` wrapper, or null.
 */
async function loadYaml() {
  const mod = await importOptional(['yaml', 'js-yaml'])
  if (mod === undefined) return null
  const api = mod.default ?? mod
  if (typeof api?.parse === 'function') return { parse: api.parse }
  if (typeof api?.load === 'function') return { parse: api.load }
  return null
}

// --------------------------------------------------------------------- port

/**
 * Check that the host is actually serving on its configured port.
 *
 * Loopback only, and it answers a real question: the roster can say the web
 * server mounted, but not that anything is reachable through it. A bound port
 * that refuses connections is the signature of a stale process holding the
 * socket.
 * @param {object} ctx - cordis context.
 * @returns {Promise<object>} the check result.
 */
async function checkWebPort(ctx) {
  const server = lookupService(ctx, 'webServer')
  if (server === undefined) {
    return warn('http.port', 'the webServer service is not mounted', 'this profile has no HTTP surface to probe')
  }
  const port = Number(read(() => server.port))
  const host = String(read(() => server.host) ?? '127.0.0.1')
  if (!Number.isFinite(port) || port <= 0) {
    return warn('http.port', 'the web server did not report a listening port')
  }
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`
  const started = Date.now()
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' })
    const ms = Date.now() - started
    if (response.status >= 500) {
      return warn('http.port', `${url} answered ${response.status} in ${ms}ms`, 'the port is served but the app is erroring')
    }
    return ok('http.port', `${url} answered ${response.status} in ${ms}ms (bound to ${host}:${port})`)
  } catch (error) {
    return warn(
      'http.port',
      `${url} is not answering: ${message(error)}`,
      'the port is bound but nothing usable is behind it -- a stale dsh process may still hold the socket',
    )
  }
}

// -------------------------------------------------------------------- tools

/**
 * Report what the install contributes to the model.
 *
 * Tool count is the cheapest proxy for "did the tool plugins really mount": the
 * roster shows the rows, this shows the payload.
 * @param {object} ctx - cordis context.
 * @returns {object} the check result.
 */
function checkTools(ctx) {
  const tools = lookupService(ctx, 'tools')
  if (tools === undefined) {
    return warn('tools.registered', 'the tools service is not mounted', 'no model-facing tools can be registered on this profile')
  }
  if (typeof tools.schemas !== 'function') {
    return warn('tools.registered', 'the tools service exposes no schemas() to enumerate')
  }
  const schemas = tools.schemas()
  if (!Array.isArray(schemas)) return warn('tools.registered', 'schemas() did not return an array')

  const names = schemas.map(schema => String(schema?.name ?? '')).filter(name => name !== '')
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
  const extra = []
  if (names.length > 0) extra.push(`  + ${names.length} tools:`)
  for (const chunk of chunked([...new Set(names)].sort(), 6)) extra.push(`      ${chunk.join(', ')}`)

  if (duplicates.length > 0) {
    return warn('tools.registered', `duplicate tool name(s): ${[...new Set(duplicates)].join(', ')}`, 'two plugins claim the same tool name; the later registration wins', extra)
  }
  if (names.length === 0) {
    return warn('tools.registered', 'no tools are registered at all', 'every tool plugin either failed to mount or registered nothing', extra)
  }
  return ok('tools.registered', `${names.length} model-facing tools registered`, extra)
}

/**
 * Split a list into fixed-size chunks.
 * @param {string[]} items - the list.
 * @param {number} size - chunk size.
 * @returns {string[][]} the chunks.
 */
function chunked(items, size) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

// ------------------------------------------------------------------ helpers

/**
 * Look up an optional service without letting the lookup itself throw.
 * @param {object} ctx - cordis context.
 * @param {string} key - service name.
 * @returns {object|undefined} the service, or undefined.
 */
function lookupService(ctx, key) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get(key) : undefined
    return service ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Read a property that may throw on access.
 * @param {Function} read - the accessor.
 * @returns {unknown} the value, or undefined.
 */
function read(accessor) {
  try {
    return accessor()
  } catch {
    return undefined
  }
}

/**
 * Read a text file without throwing.
 * @param {string} path - absolute path.
 * @returns {string|null} the contents, or null.
 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Parse JSON without throwing.
 * @param {string|null} text - the JSON text.
 * @returns {object|undefined} the parsed value, or undefined.
 */
function safeJson(text) {
  if (text === null) return undefined
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** @param {string} id - check id. @param {string} detail - what was seen. @param {string[]} [extra] - extra lines. @returns {object} an ok check. */
function ok(id, detail, extra) {
  return extraLine({ id, level: 'ok', detail }, extra)
}

/** @param {string} id - check id. @param {string} detail - what was seen. @param {string} [hint] - what to do. @param {string[]} [extra] - extra lines. @returns {object} a warn check. */
function warn(id, detail, hint, extra) {
  return extraLine(hint === undefined ? { id, level: 'warn', detail } : { id, level: 'warn', detail, hint }, extra)
}

/** @param {string} id - check id. @param {string} detail - what was seen. @param {string} [hint] - what to do. @param {string[]} [extra] - extra lines. @returns {object} a fail check. */
function fail(id, detail, hint, extra) {
  return extraLine(hint === undefined ? { id, level: 'fail', detail } : { id, level: 'fail', detail, hint }, extra)
}

/**
 * Attach optional extra lines to a check.
 * @param {object} check - the check.
 * @param {string[]} [extra] - extra indented lines.
 * @returns {object} the check.
 */
function extraLine(check, extra) {
  return extra === undefined || extra.length === 0 ? check : { ...check, extra }
}

/**
 * The worst level in a set of checks.
 * @param {Array<object>} checks - the checks.
 * @returns {string} `ok` | `warn` | `fail`.
 */
export function worstLevel(checks) {
  let worst = 'ok'
  for (const check of checks) {
    if (LEVELS.indexOf(check.level) > LEVELS.indexOf(worst)) worst = check.level
  }
  return worst
}
