/**
 * HTTP surface of dsh-session-sweeper, mounted on the harness Web server
 * under one private prefix (same pattern as other community bundles):
 *
 *   GET  /.dsh-session-sweeper/health  -> { ok: true }
 *   GET  /.dsh-session-sweeper/scan    -> ranking (biggest first)
 *   POST /.dsh-session-sweeper/trash   -> { sessionIds: string[] }
 *        (a legacy `currentSessionId` field in the body is ignored since
 *        v0.1.2: confirmation in the UI is the only delete gate)
 *
 * Requests are same-origin only: cross-site Origin / Sec-Fetch-Site are
 * rejected, and bodies must be JSON. Deletion here means "move to the
 * macOS Trash" — see lib/core.js.
 */
import { resolveDshHome, scanSessions, trashSessions } from './core.js'

export const ROUTE_PREFIX = '/.dsh-session-sweeper'

export class SweeperService {
  constructor(config = {}) {
    this.config = config
    this.dshHome = resolveDshHome(config)
    this.trashDir = typeof config.trashDir === 'string' && config.trashDir.length > 0 ? config.trashDir : undefined
    // Set by the host entry (index.js) once the workspaceRegistry service
    // is resolved; an `afterMove` hook for trashSessions (see
    // lib/registry.js). Undefined = pre-v0.1.3 behavior, rows refresh on
    // restart.
    this.releaseAccounting = undefined
  }

  async handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(body))
    }
    try {
      if (request.method === 'GET' && route === `${ROUTE_PREFIX}/health`) {
        send(200, { ok: true, dshHome: this.dshHome })
        return
      }
      const origin = request.headers?.origin
      if (origin && new URL(origin).host !== request.headers?.host) {
        send(403, { ok: false, error: { code: 'cross-site', message: 'cross-site requests are rejected' } })
        return
      }
      if (request.method === 'GET' && route === `${ROUTE_PREFIX}/scan`) {
        const result = await scanSessions(this.dshHome, this.config)
        send(200, { ok: true, ...result })
        return
      }
      if (request.method === 'POST' && route === `${ROUTE_PREFIX}/trash`) {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (!Array.isArray(body.sessionIds) || body.sessionIds.length === 0) {
          send(400, { ok: false, error: { code: 'invalid-request', message: 'sessionIds must be a non-empty array' } })
          return
        }
        const result = await trashSessions(this.dshHome, body.sessionIds, {
          ...this.config,
          trashDir: this.trashDir,
          afterMove: this.releaseAccounting,
        })
        send(200, { ok: true, ...result })
        return
      }
      send(404, { ok: false, error: { code: 'not-found', message: `no route for ${request.method} ${route}` } })
    } catch (error) {
      send(500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
    }
  }
}
