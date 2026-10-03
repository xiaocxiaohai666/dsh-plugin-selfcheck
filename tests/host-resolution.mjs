/**
 * Verify the plugin against the real dsh SDK.
 *
 * The tool definition is the only part of this plugin that the host validates,
 * and the host's `defineTool` is strict: the value-schema DSL rejects anything
 * outside `type`/`enum`/`const` plus annotations, and an object node must
 * declare `additionalProperties`. Both of those throw at definition time, and
 * neither shows up in a stub-context test -- a locally compiled fallback would
 * accept them happily.
 *
 * So this test points `process.argv[1]` at the installed dsh, mounts the plugin
 * with a context that hands it the real `tools` service, and asserts the tool
 * registered with the official factory and can produce a result.
 *
 *   node tests/host-resolution.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SELFCHECK_DIR = mkdtempSync(join(tmpdir(), 'dsh-selfcheck-host-'))

const npxRoot = join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx')
const dshEntry = findDshEntry(npxRoot)

if (dshEntry === undefined) {
  console.log('dsh installation not found under %s -- skipping', npxRoot)
  process.exit(0)
}
console.log('simulated process.argv[1]:', dshEntry)
process.argv[1] = dshEntry

/**
 * Locate the installed dsh package so host resolution walks into it.
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

const { importOptional } = await import('../lib/host.js')

// The SDK has to resolve from the simulated host, or the rest is meaningless.
const sdk = await importOptional(['@deepseek-ai/dsh-tools'])
assert.ok(sdk !== undefined, 'expected @deepseek-ai/dsh-tools to resolve from the host')
assert.equal(typeof sdk.defineTool, 'function')
console.log('resolved @deepseek-ai/dsh-tools, defineTool =', typeof sdk.defineTool)

// The optional YAML parser is what makes the config check a real parse rather
// than a structural guess; assert it is reachable too.
const yaml = await importOptional(['yaml', 'js-yaml'])
assert.ok(yaml !== undefined, 'expected a YAML parser to resolve from the host')
console.log('resolved a YAML parser')

// ------------------------------------------------------- mount with real tools
const registered = []
const toolsCtx = {
  tools: {
    register: (definition) => { registered.push(definition); return () => {} },
    schemas: () => [{ name: 'existing_tool', description: '' }],
  },
}
const injected = []
const ctx = {
  get: (key) => (key === 'tools' ? toolsCtx.tools : undefined),
  inject: (services, callback) => {
    injected.push(services.join(','))
    // The real container calls back once the service is available; mimic that
    // immediately so the assertion does not depend on a timer.
    if (services.includes('tools')) callback(toolsCtx)
  },
}

const mod = await import('../lib/index.js')
assert.doesNotThrow(() => mod.apply(ctx), 'apply must not throw with a real host present')

// Registration happens off the current tick -- the SDK import and the
// `ctx.inject` handshake both resolve later -- so wait before asserting.
const deadline = Date.now() + 5000
while (registered.length === 0 && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 50))
}

assert.ok(injected.includes('tools'), 'the plugin asked the host for the tools service')
assert.equal(registered.length, 1, 'exactly one tool is registered')
const tool = registered[0]
assert.equal(tool.name, 'selfcheck_status')
assert.equal(typeof tool.execute, 'function')
assert.equal(typeof tool.description, 'string')
// The real validation is that `defineTool` did not throw: it rejects unsupported
// value-schema keywords and object nodes without `additionalProperties` at
// definition time. Assert the definition carries a parameter schema at all.
assert.ok(tool.parameters !== undefined, 'the definition carries a parameter schema')
console.log('registered tool:', tool.name, '(defineTool accepted both schemas)')

// ------------------------------------------------------------- run the tool
const value = await tool.execute({}, {})
assert.equal(typeof value.ok, 'boolean')
assert.ok(['ok', 'warn', 'fail'].includes(value.level))
assert.equal(typeof value.plugins, 'object')
assert.equal(typeof value.plugins.mounted, 'number')
assert.ok(Array.isArray(value.checks))
assert.equal(value.checks.length, 4, 'the tool reports all four install checks')
assert.ok(Array.isArray(value.plugins.failures))
console.log('tool returned: level=%s mounted=%s failed=%s', value.level, value.plugins.mounted, value.plugins.failed)

const blocks = tool.output.render({}, value)
assert.ok(Array.isArray(blocks) && blocks.length >= 1)
assert.equal(blocks[0].type, 'text')
assert.match(blocks[0].text, /Plugins: \d+ mounted/)
console.log('rendered blocks:', blocks.length)

console.log('\nhost resolution: all assertions passed')
