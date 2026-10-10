/**
 * Host compatibility: the rule dsh actually enforces on a plugin, and the
 * profile-local exemptions that can relax it.
 *
 * Since 0.2 a host refuses to MOUNT a plugin whose `peerDependencies` name a
 * `@deepseek-ai/dsh*` package the running runtime does not satisfy. The refusal
 * happens before mounting, so the plugin never reaches the loader tree: the
 * roster shows no failed row, and the install quietly loses a plugin. That is
 * the exact blind spot this module exists to close -- the roster cannot see it,
 * so the decision has to be reproduced from the manifests instead.
 *
 * The evaluation mirrors `evaluatePluginCompatibility()` in
 * `@deepseek-ai/dsh-app-boot` on purpose. Three of its details are easy to get
 * wrong, and each one turns healthy plugins into false alarms:
 *
 *  - only `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers are gated; every
 *    other peer name is ignored;
 *  - `workspace:^`, `workspace:~` and `workspace:*` mean "the running runtime",
 *    not a range to parse;
 *  - ranges are evaluated with `includePrerelease`, so a prerelease host such as
 *    `0.2.0-rc.2` still satisfies an open lower bound like `>=0.1.7-rc.1`. A
 *    plain `semver.satisfies` would reject it and report a working plugin as
 *    broken.
 * @module dsh-plugin-selfcheck/compat
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { importOptional, readManifest } from './host.js'

/** The profile file recording exact-version exemptions. */
export const COMPATIBILITY_FILENAME = 'compatibility.json'

/** The runtime package itself. */
const DSH_PACKAGE = '@deepseek-ai/dsh'

/** The runtime's own packages, all of which the gate covers. */
const DSH_SCOPE_PREFIX = '@deepseek-ai/dsh-'

/** Peer ranges that mean "whatever the runtime is". */
const WORKSPACE_RANGES = ['workspace:^', 'workspace:~', 'workspace:*']

/** Published and scoped npm package names, as npm accepts them in a key. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** A canonical exact SemVer, optional prerelease and build metadata included. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Load semver, preferring the plugin's own resolution and falling back to the
 * host's `node_modules`.
 *
 * dsh itself depends on semver, so it is normally resolvable from the host even
 * when the plugin ships no dependencies of its own. A miss is reported as
 * `undefined` and never thrown: the caller degrades to a warning.
 * @returns {Promise<object|undefined>} the semver module.
 */
export async function loadSemver() {
  const loaded = await importOptional(['semver'])
  if (loaded === undefined) return undefined
  // CJS interop: the callable surface may sit behind `default`.
  return typeof loaded.satisfies === 'function' ? loaded : loaded.default
}

/**
 * Whether the host gate covers this peer name.
 * @param {string} name - a `peerDependencies` key.
 * @returns {boolean} true when dsh evaluates it.
 */
export function isDshPeer(name) {
  return name === DSH_PACKAGE || name.startsWith(DSH_SCOPE_PREFIX)
}

/**
 * The range the gate compares against, resolving the `workspace:` spellings.
 * @param {string} range - the declared range.
 * @param {string} runtimeVersion - the running dsh version.
 * @returns {string} a range semver can evaluate.
 */
export function requirementOf(range, runtimeVersion) {
  return WORKSPACE_RANGES.includes(range) ? runtimeVersion : range
}

/**
 * Whether a declared range accepts the running runtime, using the host's own
 * prerelease-permissive semantics.
 * @param {string} range - the declared range.
 * @param {string} runtimeVersion - the running dsh version.
 * @param {object} semver - the semver module.
 * @returns {boolean} true when accepted.
 */
export function satisfiesHost(range, runtimeVersion, semver) {
  const requirement = requirementOf(range, runtimeVersion)
  if (typeof requirement !== 'string' || requirement.trim() === '') return false
  try {
    return semver.satisfies(runtimeVersion, requirement, { includePrerelease: true }) === true
  } catch {
    // An unparsable range is a refusal, matching how dsh treats one.
    return false
  }
}

/**
 * The dsh peers a manifest fails, or null when the host would mount it.
 * @param {object|undefined} manifest - a parsed plugin package.json.
 * @param {string} runtimeVersion - the running dsh version.
 * @param {object} semver - the semver module.
 * @returns {{name: string|undefined, version: string|undefined, peers: object}|null} the issue.
 */
export function evaluatePluginCompatibility(manifest, runtimeVersion, semver) {
  const peers = manifest?.peerDependencies
  if (peers === null || peers === undefined) return null
  if (typeof peers !== 'object' || Array.isArray(peers)) return null
  const refused = {}
  for (const [name, range] of Object.entries(peers)) {
    if (!isDshPeer(name)) continue
    if (typeof range !== 'string') {
      refused[name] = String(range)
      continue
    }
    if (!satisfiesHost(range, runtimeVersion, semver)) refused[name] = range
  }
  if (Object.keys(refused).length === 0) return null
  return {
    name: typeof manifest.name === 'string' ? manifest.name : undefined,
    version: typeof manifest.version === 'string' ? manifest.version : undefined,
    peers: refused,
  }
}

/**
 * Whether the host would mount a manifest as-is.
 * @param {object|undefined} manifest - a parsed plugin package.json.
 * @param {string} runtimeVersion - the running dsh version.
 * @param {object|undefined} semver - the semver module, or undefined when absent.
 * @returns {boolean} true when the host accepts it; false when it may refuse.
 */
export function hostAccepts(manifest, runtimeVersion, semver) {
  if (semver === undefined || semver === null) return false
  return evaluatePluginCompatibility(manifest, runtimeVersion, semver) === null
}

/**
 * The exact-version exemptions a profile records.
 *
 * The file maps `name@exact-version` keys to the exact DSH versions the user
 * explicitly allowed. Records that are not shaped that way are dropped WITH a
 * warning, mirroring how the host reads the same file: a key that could never
 * match is worthless as a grant, and silently accepting one would let a typo
 * read as a working override.
 * @param {string|null} dir - the profile directory, or null when not located.
 * @returns {{exemptions: object, warnings: string[]}} the exemptions and problems.
 */
export function readExemptions(dir) {
  if (typeof dir !== 'string' || dir === '') return { exemptions: {}, warnings: [] }
  const path = join(dir, COMPATIBILITY_FILENAME)
  if (!existsSync(path)) return { exemptions: {}, warnings: [] }
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { exemptions: {}, warnings: [`${COMPATIBILITY_FILENAME} is not valid JSON; no exemptions applied`] }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { exemptions: {}, warnings: [`${COMPATIBILITY_FILENAME} must map package@version keys to DSH version lists`] }
  }
  const exemptions = {}
  const warnings = []
  for (const [key, versions] of Object.entries(value)) {
    const separator = key.lastIndexOf('@')
    const name = separator > 0 ? key.slice(0, separator) : ''
    const version = separator > 0 ? key.slice(separator + 1) : ''
    if (!PACKAGE_NAME.test(name) || !EXACT_VERSION.test(version)) {
      warnings.push(`${COMPATIBILITY_FILENAME}: ${JSON.stringify(key)} is not an exact package-name@version key; the record is ignored`)
      continue
    }
    if (!Array.isArray(versions) || !versions.every(entry => typeof entry === 'string')) {
      warnings.push(`${COMPATIBILITY_FILENAME}: ${key} must contain a list of exact DSH versions; the record is ignored`)
      continue
    }
    exemptions[key] = versions
  }
  return { exemptions, warnings }
}

/**
 * Whether an exact `name@version` key is exempted for this runtime.
 * @param {object} exemptions - the parsed exemption map.
 * @param {string} key - `name@exact-version`.
 * @param {string} runtimeVersion - the running dsh version.
 * @returns {boolean} true when the exemption covers this runtime.
 */
export function isExempted(exemptions, key, runtimeVersion) {
  const versions = exemptions[key]
  return Array.isArray(versions) && versions.includes(runtimeVersion)
}

/**
 * The bundle specifiers the profile declares.
 *
 * Read from the profile manifest rather than the loader tree, because the whole
 * point is to reach the bundles the host SKIPPED -- those are absent from the
 * tree by definition.
 * @param {string|null} dir - the profile directory, or null when not located.
 * @returns {string[]} the declared specifiers.
 */
export function declaredBundles(dir) {
  if (typeof dir !== 'string' || dir === '') return []
  const manifest = readManifest(join(dir, 'package.json'))
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return []
  return bundles.filter(entry => typeof entry === 'string')
}
