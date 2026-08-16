/**
 * @coomi/coomi-web-app — the browser-surface bundle's runtime glue plugin
 * plus the bundle patch (`cordis.patch.yml`, declared by the `coomi.bundle.patch`
 * manifest field). The plugin owns the browser-surface glue: it resolves
 * the built frontend dist (workspace knowledge of this bundle, never user
 * config), mounts the `frontend-static` fallback owner over it, registers the
 * harness-source and web-surface prompt sections, the bash-visible web runtime
 * variable, and the URL line. App command-line values arrive through the
 * `webStartup` service expressions in the bundle patch.
 * @module @coomi/coomi-web-app
 */

import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@coomi/cordis'
import z from '@coomi/schemastery'
import { addHarnessSourceSection } from '@coomi/coomi-app-boot'
import * as FrontendStatic from '@coomi/coomi-host-frontend-static'
import type {} from '@coomi/cordis-plugin-loader'
import type {} from '@coomi/coomi-host-webserver'
import type {} from '@coomi/coomi-system-prompt'
import type {} from '@coomi/coomi-shell-env'

/** Stable Cordis plugin name. */
export const name = 'web-app'

/** This coomi installation's root, from either this package's source or built entry. */
const SOURCE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** Runtime service that releases Web rows after bind-dependent values resolve. */
const WEB_RUNTIME_SERVICE = 'webRuntime'

/** Services required before the web runtime can mount. */
export const inject = ['webServer']

/** Plugin config: composed deployment settings plus per-invocation command-line values. */
export interface Config {
  /** Print the URL line on activation; a non-interactive layer can turn it off. */
  printUrl: boolean
  /**
   * Register the model-visible surface context (the `app:web-surface` prompt
   * section and the `COOMI_WEB_URL` bash variable). A one-shot non-interactive
   * layer can turn it off when its user is not in the GUI, so the
   * orientation text would be false.
   */
  surfaceContext: boolean
  /** Explicit `--trusted-host` authorities from this invocation. */
  trustedHosts: string[]
}

export const Config: z<Config> = z.object({
  printUrl: z.boolean().default(true),
  surfaceContext: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
})

/** Bind-dependent Web values shared by the trust fence and URL display. */
export interface WebRuntimeValues {
  /** LAN IPv4 literals sampled once when the server binds all interfaces. */
  lanAddresses: string[]
  /** LAN literals followed by explicit invocation authorities. */
  trustedHosts: string[]
}

/** Environment variable naming the canonical local URL of this Web GUI. */
const COOMI_WEB_URL = 'COOMI_WEB_URL' as const

// Display-only mirror of the webserver schema's loopback host: the address the
// local URL always prints. Not a source of truth — the schema is.
const LOOPBACK_HOST = '127.0.0.1'
/** The webserver schema's all-interfaces bind literal. */
const ALL_INTERFACES_HOST = '0.0.0.0'

/**
 * Resolve one LAN-trust snapshot from the active server bind.
 *
 * Derived entries are port-less IP literals: DNS rebinding needs an
 * attacker-controlled name, while an IP-literal Host is safe on any port and
 * an OS-assigned port is unknowable before bind.
 * @param bindHost - the active webserver bind host.
 * @param extra - explicit `--trusted-host` values, in argument order.
 * @returns the LAN display addresses and invocation-derived fence authorities.
 */
export function resolveLanTrust(bindHost: string, extra: readonly string[]): WebRuntimeValues {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST
    ? Object.values(networkInterfaces()).flat()
      .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
      .map(iface => iface.address)
    : []
  return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] }
}

/** Model-visible orientation and acceptance boundary for sessions created through `coomi web`. */
function webSurfacePrompt(webUrl: string): string {
  const updateContract = 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
    + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
    + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  return `You are interacting with the user through the Coomi Web GUI at ${webUrl}. `
    + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
    + 'The browser provides no implicit DOM, route, or screenshot context. '
    + updateContract
    + 'Starting another server does not update this GUI. '
    + 'The apps/web Vite entry builds the shell but is not a standalone application because only coomi web injects window.__COOMI_BOOT__. '
    + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'
}

/** Resolve the canonical loopback URL from the active Web server. */
function localWebUrl(ctx: Context): string {
  const port = ctx.get('webServer')?.port
  if (port === undefined) throw new Error('web-app: webServer service missing while resolving Web runtime')
  return `http://${LOOPBACK_HOST}:${String(port)}`
}

/** Dist location is workspace knowledge of this bundle: resolved through the frontend package exports, not configured. */
function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  try {
    return require.resolve('@coomi/coomi-web-frontend/dist/index.html')
  } catch {
    /* v8 ignore next 2 -- reachable only on a checkout without a built dist; the test tree builds it */
    throw new Error('web-app: frontend dist not built; run pnpm run build from the repository root first')
  }
}

/** Test hook: hosts with no built frontend dist substitute the resolver; production never touches this. */
export const internals: { resolveDistIndex: () => string } = { resolveDistIndex }

/**
 * Mount the Web runtime: dist serving, surface prompt, the bash runtime
 * variable, and the URL line.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const runtime = resolveLanTrust(ctx.webServer.host, config.trustedHosts)
  // Release dependent rows only after bind-dependent trust has been sampled once.
  ctx.provide(WEB_RUNTIME_SERVICE, runtime)
  ctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() })
  if (config.surfaceContext) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      addHarnessSourceSection(promptCtx, SOURCE_ROOT)
      promptCtx.systemPrompt.section({
        name: 'app:web-surface',
        order: -98,
        text: () => webSurfacePrompt(localWebUrl(promptCtx)),
      })
    })
    ctx.inject(['shellEnv'], (runtimeCtx) => {
      runtimeCtx.shellEnv.register({
        name: 'web-runtime',
        variables: {
          [COOMI_WEB_URL]: { description: 'Canonical local URL of the Coomi Web GUI serving this session.' },
        },
        resolve: () => ({ [COOMI_WEB_URL]: localWebUrl(runtimeCtx) }),
      })
    })
  }
  if (config.printUrl) {
    // The URL line is a readiness signal: supervisors (and the keyless CLI
    // smoke) RPC as soon as they observe it, so it must not print while
    // sibling rows (the /api route owner) are still mounting. Await Loader
    // settlement first; a hand-built tree without a Loader prints at once.
    const printUrl = (): void => {
      // Reuse the exact LAN snapshot provided to the /api trust fence.
      const lanCandidate = runtime.lanAddresses[0]
      const port = ctx.webServer.port
      console.log(`coomi web: ${localWebUrl(ctx)}${lanCandidate === undefined ? '' : ` (LAN: http://${lanCandidate}:${String(port)})`}`)
    }
    // This row's own activation can precede a sibling failure. The app owns
    // readiness by waiting for its Loader tree, or prints at once in a
    // hand-built context without Loader.
    const settled = ctx.get('loader')?.await()
    if (settled === undefined) printUrl()
    else {
      void settled.then(() => {
        // The tree can be disposed while the boot was in flight (early
        // SIGTERM); a URL line for a dead server would only mislead, and
        // reading the torn-down port would turn a clean shutdown into a crash.
        if (ctx.get('webServer') !== undefined) printUrl()
      // Loader reports a failed boot; this row only stays quiet.
      }, () => {})
    }
  }
}
