/**
 * Terminal-first self-check for a DeepSeek Harness install.
 *
 * At mount the plugin waits for the loader tree to settle, prints every plugin
 * row (mounted / disabled / failed, with the exception text when there is one),
 * then runs four install-level checks and prints a one-line verdict. The whole
 * report is also written to disk and exposed to the model through a single
 * `selfcheck_status` tool.
 *
 * Design constraints worth keeping:
 *  - `inject` is empty on purpose. A diagnostic that refuses to mount because a
 *    service is missing cannot report that the service is missing.
 *  - Nothing here is specific to any plugin, machine, or install path. The rows
 *    come from `ctx.loader.entries()` and every path is derived from the running
 *    host, so the plugin describes the USER's install.
 *  - Output goes to the console first. The cordis logger does not reach the
 *    window `start-dsh.bat` opens, and a self-check nobody sees is pointless.
 * @module dsh-plugin-selfcheck
 */
import { runChecks } from './checks.js'
import { importOptional } from './host.js'
import { makeSink, message } from './log.js'
import { buildReport, persistReport, renderReport } from './report.js'
import { collectRoster } from './roster.js'

/** Plugin id, matching the bundle row in `cordis.patch.yml`. */
export const name = 'selfcheck'

/**
 * No required services.
 *
 * Everything is resolved defensively with `ctx.get()`. Requiring a service here
 * would mean the plugin stays unmounted and silent on exactly the broken installs
 * it was written to describe.
 */
export const inject = []

/** The one tool this plugin contributes to the model. */
export const TOOL_NAME = 'selfcheck_status'

/**
 * Mount the plugin.
 * @param {object} ctx - cordis context.
 * @returns {void}
 */
export const apply = (ctx) => {
  const sink = makeSink(ctx)
  const startedAt = Date.now()

  let latest = null
  let pending = null

  /**
   * Run the check once and memoise it.
   * @returns {Promise<object>} the report.
   */
  const run = () => {
    if (pending === null) {
      pending = execute(ctx, sink, startedAt)
        .then((report) => {
          latest = report
          return report
        })
        .catch((error) => {
          // The plugin is a diagnostic: it must never surface as a mount failure.
          sink(`  self-check itself failed: ${message(error)}`, 'warn')
          return null
        })
    }
    return pending
  }

  registerTool(ctx, run, () => latest)

  // Not awaited: `apply` stays synchronous so cordis can finish mounting the row,
  // and the run deliberately watches the tree settle afterwards.
  run()
}

/**
 * Collect everything and print it.
 * @param {object} ctx - cordis context.
 * @param {Function} sink - the log sink.
 * @param {number} startedAt - `Date.now()` at mount.
 * @returns {Promise<object>} the report.
 */
async function execute(ctx, sink, startedAt) {
  const roster = await collectRoster(ctx)
  const checks = await runChecks(ctx, roster)
  const report = buildReport({ roster, checks, host: hostFingerprint(ctx), startedAt })

  for (const line of renderReport(report)) sink(line.text, line.level)
  persistReport(report)
  return report
}

/**
 * A minimal fingerprint of the host, for the JSON report.
 * @param {object} ctx - cordis context.
 * @returns {object} `{ node, dsh, profile }`.
 */
function hostFingerprint(ctx) {
  const profile = (() => {
    try {
      const baseUrl = ctx?.baseUrl
      return typeof baseUrl === 'string' ? baseUrl : null
    } catch {
      return null
    }
  })()
  return { node: process.versions.node, profile }
}

/**
 * Register the model-facing status tool, if the host can take one.
 *
 * Deliberately optional and deliberately without a fallback compiler: a locally
 * compiled `defineTool` behaves subtly differently from the host's own, and
 * shipping that difference inside a diagnostic would undermine the point. If the
 * SDK is unavailable the plugin keeps its primary job -- printing the report.
 * @param {object} ctx - cordis context.
 * @param {Function} run - starts (or joins) the check.
 * @param {Function} latest - reads the most recent report.
 * @returns {void}
 */
function registerTool(ctx, run, latest) {
  Promise.resolve()
    .then(async () => {
      const sdk = await importOptional(['@deepseek-ai/dsh-tools'])
      if (sdk === undefined || typeof sdk.defineTool !== 'function') return
      ctx.inject(['tools'], (toolsCtx) => {
        try {
          toolsCtx.tools.register(sdk.defineTool({
            name: TOOL_NAME,
            description: 'Report the health of this DeepSeek Harness install: which plugins mounted, which failed '
              + 'and why, whether any plugin disagrees with the installed dsh version, whether the profile config '
              + 'files are valid, whether the web port answers, and how many tools are registered. '
              + 'Call this when the user asks why something is not working, whether their plugins loaded, or what '
              + 'is broken after an update. It reads the current process; it does not change anything.',
            parameters: {},
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean' },
                  level: { type: 'string' },
                  plugins: { type: 'object', additionalProperties: true },
                  checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  reportPath: { type: 'string' },
                },
              },
              render: (_args, value) => [{ type: 'text', text: renderToolText(value) }],
            },
            presentCall: () => ({ card: 'generic', title: 'Checking plugin health', kind: 'read' }),
            async execute() {
              const report = await run()
              if (report === null) {
                return { ok: false, level: 'fail', plugins: {}, checks: [], reportPath: '' }
              }
              return {
                ok: report.ok,
                level: report.level,
                plugins: {
                  mounted: report.plugins.counts.ok,
                  disabled: report.plugins.counts.skip,
                  failed: report.plugins.counts.fail,
                  failures: report.plugins.rows.filter(row => row.state === 'fail').map(row => ({
                    name: row.name,
                    id: row.id,
                    error: row.error,
                  })),
                  errors: report.plugins.errors,
                },
                checks: report.checks,
                reportPath: '',
              }
            },
          }))
        } catch {
          // A host that refuses the registration must not cost the report.
        }
      })
    })
    .catch(() => {
      // SDK probing is best-effort by design.
    })
  void latest
}

/**
 * Render the tool result as text the model can act on.
 * @param {object} value - the tool value.
 * @returns {string} a compact multi-line summary.
 */
function renderToolText(value) {
  const lines = [
    `Plugins: ${value.plugins.mounted ?? 0} mounted, ${value.plugins.disabled ?? 0} disabled, ${value.plugins.failed ?? 0} failed`,
  ]
  for (const failure of value.plugins.failures ?? []) {
    lines.push(` - FAILED ${failure.name} (${failure.id})${failure.error === null ? '' : `: ${failure.error}`}`)
  }
  for (const text of value.plugins.errors ?? []) lines.push(` ! ${text}`)
  for (const check of value.checks ?? []) {
    lines.push(`${check.level.toUpperCase().padEnd(5)} ${check.id}: ${check.detail}`)
  }
  return lines.join('\n')
}
