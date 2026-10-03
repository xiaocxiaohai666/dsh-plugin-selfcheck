# dsh-plugin-selfcheck

Terminal-first self-check for a [DeepSeek Harness](https://github.com/deepseek-ai) install.

At every boot it prints, **in the console window dsh was started from**, every plugin row in the loader tree — mounted, disabled, or **failed with the exception text** — followed by four install-level checks. Then it gets out of the way.

English | [中文](README.zh.md)

## Why this exists

cordis already ships this feature. `Loader.showLog()` prints `apply plugin <name>` on every mount. Two things defeat it:

1. **It is off by default.** It is gated behind `entry.parent.tree.enableLogs`, and `dsh web --help` has no flag for it.
2. **Its output channel is invisible.** It writes through `ctx.root.logger`, which under the dsh CLI reaches neither the console window nor the `dsh-run.log` that window is redirected into.

So enabling the flag only moves the silence. A roster a human can actually see has to be written to `console` from inside the host process — which is all this plugin does.

## What it prints

```
[selfcheck] plugin self-check
[selfcheck]  ok   @deepseek-ai/dsh-base                       include
[selfcheck]  ok   dshmarket                                   include:dsh-market
[selfcheck]  skip @deepseek-ai/cordis-plugin-hmr  51ad9c62    (disabled)
[selfcheck]  ok   @liustack/modlens                           include:modlens
[selfcheck]  ok   dsh-tool-stable-diffusion                   include:stable-diffusion
[selfcheck]  ---- plugins: 148 mounted, 28 disabled, 0 failed
[selfcheck]  ---- install checks:
[selfcheck]  ok   deps.version-drift    all 9 plugins declaring dsh.engines.dsh accept 0.1.2-rc.1
[selfcheck]  ok   config.files          ~/.dsh/profiles/web (3 files checked)
[selfcheck]  ok   http.port             http://127.0.0.1:3080/ answered 200 in 3ms
[selfcheck]  ok   tools.registered      34 model-facing tools registered
[selfcheck]  ---- selfcheck OK - 148 mounted, 0 failed, checks 4 ok / 0 warn / 0 fail (742ms)
```

Row states are three, and `skip` is **not** a failure — a row you disabled is working as intended:

| State | Meaning |
| --- | --- |
| `ok` | mounted |
| `skip` | disabled (shown with `(disabled)`) |
| `FAIL` | never mounted — and it goes to stderr |

The row count is much larger than your bundle count because the tree is enumerated recursively: one package like `@linxin666/dsh-web-all` expands into twenty-odd rows.

### When something breaks

```
[selfcheck]  ---- plugins: 147 mounted, 28 disabled, 1 failed
[selfcheck]  ---- problems:
[selfcheck]  FAIL dsh-open-file  include:open-file
[selfcheck]  ---- error details:
[selfcheck]  ! loader fibers failed
[selfcheck]    failed to apply loader entry include:open-file (dsh-open-file): Cannot find module 'x'
```

Wrapped errors are unwrapped all the way down (`AggregateError` → `cause` chain), so you get the innermost cause rather than a useless top-level message.

## The four install checks

| Check | Question it answers | How |
| --- | --- | --- |
| `deps.version-drift` | Do my plugins still accept this dsh version? | Reads each row's `package.json` → `dsh.engines.dsh` and evaluates it against the installed `@deepseek-ai/dsh` version. The range evaluator supports `>=`, `>`, `<=`, `<`, `=`, `^`, `~`, `\|\|` and prereleases. A range it cannot parse is reported as **undecidable**, never as a pass. |
| `config.files` | Are my profile config files valid? | Parses `cordis.yml`, `cordis.patch.yml` and `package.json`, and asserts the shapes the loader requires (top-level array, `dsh.profile.bundles` present). Degrades to a structural check when no YAML parser is reachable. |
| `http.port` | Is the host actually serving? | Loopback `GET /` against the port `webServer` reports. A bound port that refuses connections is the signature of a stale process still holding the socket. |
| `tools.registered` | What did all this contribute to the model? | `ctx.tools.schemas()` — count, names, and duplicate detection. |

## Everything is derived at runtime

Nothing is hard-coded to the author's machine:

- plugin rows come from `ctx.loader.entries()`, so it reports **whatever you have installed**;
- the profile directory comes from the loader context's `baseUrl`, not from a guessed `~/.dsh/profiles/<name>`;
- package manifests are found by walking up from the running process entry, so a relocated dsh install still works.

Install a plugin, restart, and it appears in the list. No configuration, no allow-list, no registration step.

## Install

```sh
dsh plugin --profile web add dsh-plugin-selfcheck
```

From a local checkout:

```sh
dsh plugin --profile web add link:/path/to/dsh-plugin-selfcheck
```

> **Cross-drive note.** When the profile lives on `C:` and the source on another drive, pnpm cannot create a symlink and installs an empty directory, after which dsh reports `declares no dsh.bundle — installed as a plain dependency`. Create the junction by hand and reconcile:
>
> ```sh
> node -e "require('fs').symlinkSync('<abs source>','<profile>/node_modules/dsh-plugin-selfcheck','junction')"
> dsh plugin --profile web install
> ```

**Restart dsh afterwards** — bundle rows are loaded at startup.

## Where the output lands

| Where | What |
| --- | --- |
| The console window | live, at boot |
| `$DSH_HOME/dsh-plugin-selfcheck.log` | the same report as text (defaults to `~/.dsh`) |
| `$DSH_HOME/dsh-plugin-selfcheck.json` | the same report as JSON |
| tool `selfcheck_status` | the model can ask for it and explain what is broken |

## The `selfcheck_status` tool

Lets the agent answer "why is my plugin not working?" itself. It registers only when `@deepseek-ai/dsh-tools` resolves, and deliberately ships **no fallback compiler**: a locally compiled `defineTool` behaves subtly differently from the host's own, and quietly shipping that difference inside a diagnostic would undermine the point. Without the SDK the plugin keeps its primary job.

## Design rules

These are load-bearing, not style preferences.

- **`inject` is empty.** A diagnostic that refuses to mount because a service is missing cannot report that the service is missing.
- **The self-check never throws.** Every probe is individually guarded; a check that fails is reported as a `warn`, never propagated.
- **A failure never aborts the mount.** It is logged loudly and shown in the report; the plugin stays usable.
- **The loader is never `await`ed.** `EntryTree.await()` waits on every entry *including the caller*, which deadlocks from inside a plugin. The tree is instead sampled until its size settles, and the error probe runs afterwards behind a 4 s timeout — so a stall can only cost the error detail, never the report.
- **Console first, logger second.** See "Why this exists".
- **No writes without a real loader.** A bare process (a test run) has no tree, and letting it rewrite the real report would be pollution.

## Tests

```sh
npm test
```

| File | Covers |
| --- | --- |
| `tests/smoke.mjs` | mounting against a service-less and a hostile context; report shape; file persistence and its guard |
| `tests/roster.mjs` | the three row states, group filtering, `AggregateError`/`cause` unwrapping, the timeout guard |
| `tests/checks.mjs` | every semver range form case by case; the config check against valid, malformed and bundle-less profiles; tools; the port probe; four checks surviving a throwing context |
| `tests/host-resolution.mjs` | the tool and output schemas validated by the **real** `defineTool` from an installed dsh — the only place the value-schema DSL restrictions show up |

`host-resolution.mjs` skips cleanly when no dsh install is present.

## Relationship to `@linxin666/dsh-doctor`

That plugin already covers plugin health in depth, and this one deliberately does **not** compete with it: no supervisor, no rescue capsule, no rollback, no web console, no client half. Its differentiation is being terminal-first — you see the state of the install **before the browser opens**, in the window you are already looking at, with no service to keep running.

They can be installed side by side.

## License

MIT
