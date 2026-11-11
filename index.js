/**
 * Host entry of `dsh-session-sweeper`.
 *
 * Registers the sweeper HTTP routes on the composed Web server inside one
 * ctx.effect, so disabling the bundle row unregisters them cleanly.
 * The browser half is served from `./client` (see package.json `dsh.client`).
 *
 * The effect also installs the accounting-release hook so deleted
 * sessions vanish from the sidebar immediately. v0.1.3 resolved
 * `workspaceRegistry` with a one-shot lookup at activation time
 * (`ctx.get`), which raced the service's initialization: on the real
 * desktop build it returned undefined, the hook was silently never
 * installed, and rows survived until restart — indistinguishable from
 * v0.1.2. v0.1.4 therefore waits for the service with
 * `ctx.inject(['workspaceRegistry'], childCtx => …)` (the host's own
 * idiom), and logs whether the hook was enabled, so a degraded install
 * (service truly unavailable → rows refresh on restart) leaves a trace
 * instead of failing silently.
 */
import { createReleaseAccounting, resolveWorkspaceRegistry } from './lib/registry.js'
import { ROUTE_PREFIX, SweeperService } from './lib/service.js'

export const name = 'dsh-session-sweeper'

/** The Web server must exist before routes can be mounted. */
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const service = new SweeperService(config ?? {})
  ctx.effect(() => {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) throw new Error('dsh-session-sweeper: webServer service is unavailable')
    let disposeInject
    if (typeof ctx.inject === 'function') {
      disposeInject = ctx.inject(['workspaceRegistry'], (childCtx) => {
        let registry = childCtx?.workspaceRegistry
        if (!registry) {
          try {
            registry = childCtx?.get?.('workspaceRegistry')
          } catch {
            registry = undefined
          }
        }
        service.releaseAccounting = createReleaseAccounting(registry)
        if (registry) {
          console.info('dsh-session-sweeper: workspaceRegistry accounting release enabled')
        } else {
          console.warn('dsh-session-sweeper: workspaceRegistry unavailable; deleted rows will refresh on restart')
        }
      })
    } else {
      // Hosts without ctx.inject (not expected on the real build): keep
      // the v0.1.3 one-shot lookup as a last-resort fallback.
      service.releaseAccounting = createReleaseAccounting(resolveWorkspaceRegistry(ctx))
    }
    const disposeRoute = webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (request, response) => {
        void service.handle(request, response).catch((error) => {
          if (!response.headersSent) {
            response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            response.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(error) } }))
          } else {
            response.destroy()
          }
        })
      },
    })
    return () => {
      service.releaseAccounting = undefined
      if (typeof disposeInject === 'function') disposeInject()
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  }, 'dsh-session-sweeper: routes')
}
