/**
 * Host discovery: where dsh lives, what it declares, and which package backs a
 * loader row.
 *
 * Everything here is derived from the RUNNING process. Nothing is hard-coded to
 * this machine, because the whole point of the plugin is to work on someone
 * else's install: the profile directory, the SDK root, and the dsh version are
 * all read at boot from the host that is actually running.
 * @module dsh-plugin-selfcheck/host
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** How far up the filesystem to look for the host's `node_modules`. */
const MAX_WALK = 8

/**
 * Candidate `node_modules` directories belonging to the running host.
 *
 * The plugin is normally installed as a `link:`, so its own bare imports resolve
 * from a source directory with no `node_modules`. Walking up from the process
 * entry finds the real one without hard-coding an install path (which moves on
 * every dsh update).
 * @returns {string[]} absolute paths that contain an `@deepseek-ai` directory.
 */
export function hostModuleRoots() {
  const roots = new Set()
  const seeds = [process.argv[1], process.execPath]
    .filter(value => typeof value === 'string' && value !== '')
  for (const seed of seeds) {
    let dir = dirname(resolve(seed))
    for (let depth = 0; depth < MAX_WALK; depth++) {
      const candidate = join(dir, 'node_modules')
      if (existsSync(join(candidate, '@deepseek-ai'))) roots.add(candidate)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return [...roots]
}

/**
 * Import one of several specifiers, preferring the plugin's own resolution and
 * falling back to the host's `node_modules`.
 *
 * Used for soft dependencies (a YAML parser). A miss is reported as `undefined`
 * and never thrown: the caller degrades instead of failing the mount.
 * @param {string[]} specifiers - bare specifiers, most preferred first.
 * @returns {Promise<object|undefined>} the first module that loaded.
 */
export async function importOptional(specifiers) {
  for (const specifier of specifiers) {
    try {
      return await import(specifier)
    } catch {
      // try the next candidate
    }
  }
  for (const root of hostModuleRoots()) {
    for (const specifier of specifiers) {
      const loaded = await importFromRoot(root, specifier)
      if (loaded !== undefined) return loaded
    }
  }
  return undefined
}

/**
 * Load a package from one concrete `node_modules` directory.
 * @param {string} root - the `node_modules` directory.
 * @param {string} specifier - bare package specifier.
 * @returns {Promise<object|undefined>} the module, or undefined.
 */
async function importFromRoot(root, specifier) {
  const packageDir = join(root, ...specifier.split('/'))
  const manifest = readManifest(join(packageDir, 'package.json'))
  if (manifest === undefined) return undefined
  const entry = pickEntry(manifest)
  if (entry === undefined) return undefined
  try {
    return await import(pathToFileURL(join(packageDir, entry)).href)
  } catch {
    return undefined
  }
}

/**
 * Choose a module entry point from a package manifest.
 * @param {object} manifest - parsed package.json.
 * @returns {string|undefined} a package-relative entry path.
 */
function pickEntry(manifest) {
  if (typeof manifest.main === 'string') return manifest.main
  const exportsField = manifest.exports
  if (typeof exportsField === 'string') return exportsField
  const root = exportsField?.['.']
  if (typeof root === 'string') return root
  if (typeof root?.import === 'string') return root.import
  if (typeof root?.default === 'string') return root.default
  return undefined
}

/**
 * Parse a package.json without throwing.
 * @param {string} path - absolute path to the manifest.
 * @returns {object|undefined} the parsed manifest, or undefined.
 */
export function readManifest(path) {
  try {
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The package name a loader specifier resolves to.
 *
 * Loader rows name either a package (`dshmarket`), a subpath of one
 * (`@linxin666/dsh-web-all/ssh`), a builtin (`cordis:include`), or a relative
 * path. Only the first two have an installed manifest to inspect.
 * @param {string} specifier - `entry.options.name`.
 * @returns {string|null} the package name, or null when there is none.
 */
export function packageNameOf(specifier) {
  const value = String(specifier ?? '').trim()
  if (value === '' || value.startsWith('.') || value.startsWith('/')) return null
  if (/^[a-zA-Z]:[\\/]/.test(value)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null
  const segments = value.split('/').filter(Boolean)
  if (segments.length === 0) return null
  if (value.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null
  }
  return segments[0]
}

/**
 * Every directory an installed plugin could live in.
 *
 * The plugin's own `node_modules` comes first: dsh installs a profile's plugins
 * there, and that is where a row's manifest actually is. The SDK roots are the
 * fallback, because a dsh builtin is installed next to dsh itself.
 * @param {object} ctx - cordis context.
 * @param {object} [loader] - the loader service.
 * @returns {string[]} absolute `node_modules` directories, most specific first.
 */
export function installedRoots(ctx, loader) {
  const roots = []
  const dir = profileDir(ctx, loader)
  if (dir !== null) roots.push(join(dir, 'node_modules'))
  for (const root of hostModuleRoots()) roots.push(root)
  return [...new Set(roots)]
}

/**
 * Find an installed package manifest across the given roots.
 * @param {string} packageName - bare package name.
 * @param {string[]} [roots] - directories to search; defaults to the SDK roots.
 * @returns {{manifest: object, dir: string, root: string}|undefined} the find.
 */
export function findInstalledPackage(packageName, roots = hostModuleRoots()) {
  for (const root of roots) {
    const dir = join(root, ...packageName.split('/'))
    const manifest = readManifest(join(dir, 'package.json'))
    if (manifest !== undefined) return { manifest, dir, root }
  }
  return undefined
}

/**
 * The profile directory that owns this boot.
 *
 * Read from the loader context's `baseUrl`, which `boot()` sets to the directory
 * of the profile config file. That is how the plugin finds the user's config
 * without assuming `~/.dsh/profiles/<name>`.
 * @param {object} ctx - cordis context.
 * @param {object} [loader] - the loader service, whose own context also carries it.
 * @returns {string|null} an absolute directory path, or null.
 */
export function profileDir(ctx, loader) {
  // Each candidate is read through its own guard: these can be throwing getters
  // on a half-initialised context, and building the array outright would let one
  // of them abort the whole lookup.
  const accessors = [() => ctx?.baseUrl, () => loader?.ctx?.baseUrl, () => loader?.baseUrl]
  for (const accessor of accessors) {
    let value
    try {
      value = accessor()
    } catch {
      continue
    }
    const path = toPath(value)
    if (path !== null) return path
  }
  return null
}

/**
 * Convert a file URL (or plain path) to a filesystem path.
 * @param {unknown} value - the candidate.
 * @returns {string|null} an absolute path, or null.
 */
export function toPath(value) {
  if (typeof value !== 'string' || value === '') return null
  try {
    if (value.startsWith('file:')) return fileURLToPath(value)
    return resolve(value)
  } catch {
    return null
  }
}
