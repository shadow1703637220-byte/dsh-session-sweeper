/**
 * Host workspace-registry accounting release (v0.1.3).
 *
 * The sidebar does not read session directories off disk; rows are
 * projected from the persistent workspace registry (`Workspace.sessionIds`
 * minus archived, plus live SessionStore entries). Moving files alone
 * therefore left the row visible until a restart. This module builds the
 * `afterMove` hook for `trashSessions`: it is called strictly AFTER a
 * session's files reached the Trash, and releases the registry side so
 * the row disappears immediately through the same WorkspaceView upsert
 * channel that archive/pin use.
 *
 * Signatures verified against the host's app.asar by the Mac-side agent
 * (2026-11-11):
 *   WorkspaceRegistry.list(): Workspace[]
 *   WorkspaceRegistry.unarchiveSession(id): Promise<void>  (no-op if absent)
 *   WorkspaceRegistry.unpinSession(id): Promise<void>      (no-op if absent)
 *   WorkspaceRegistry.stopSessionActivity(id): Promise<void>
 *   Workspace.detachSession(id): Promise<void>
 *
 * Every step is independently fault-tolerant: a failing step is
 * collected and the remaining steps still run; if anything failed the
 * hook throws an aggregate error, which `trashSessions` records as an
 * accounting failure (files stay in the Trash, no rollback).
 * A missing registry or missing methods degrade to the pre-v0.1.3
 * behavior (row disappears on next restart) instead of failing deletes.
 */
export function createReleaseAccounting(registry) {
  if (!registry) return undefined
  return async function releaseAccounting(entry, target) {
    const sessionId = entry.sessionId
    const errors = []
    const step = async (name, fn) => {
      try {
        await fn()
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Live session: stop the in-flight turn first (equivalent of the user
    // pressing stop), so its SessionStore entry can retire.
    if (target?.live && typeof registry.stopSessionActivity === 'function') {
      await step('stopSessionActivity', () => registry.stopSessionActivity(sessionId))
    }

    // Detach from whichever workspace holds the session.
    if (typeof registry.list === 'function') {
      let workspaces = []
      try {
        workspaces = registry.list() ?? []
      } catch (error) {
        errors.push(`list: ${error instanceof Error ? error.message : String(error)}`)
      }
      const holder = [...workspaces].find(
        (ws) => ws && typeof ws.detachSession === 'function' && Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId),
      )
      if (holder) await step('detachSession', () => holder.detachSession(sessionId))
    }

    // Clear global archive/pin marks (idempotent no-ops when absent).
    if (typeof registry.unarchiveSession === 'function') {
      await step('unarchiveSession', () => registry.unarchiveSession(sessionId))
    }
    if (typeof registry.unpinSession === 'function') {
      await step('unpinSession', () => registry.unpinSession(sessionId))
    }

    if (errors.length > 0) throw new Error(errors.join('; '))
  }
}

/**
 * FALLBACK ONLY (since v0.1.4): one-shot lookup of the workspaceRegistry
 * service via `ctx.get('workspaceRegistry')`, then the
 * `ctx.workspaceRegistry` property form. This races service
 * initialization at activation time and silently lost that race on the
 * real desktop build (v0.1.3 field failure), so index.js now waits via
 * `ctx.inject(['workspaceRegistry'], …)` as the main path and only uses
 * this where `ctx.inject` does not exist.
 */
export function resolveWorkspaceRegistry(ctx) {
  try {
    const viaGet = ctx.get?.('workspaceRegistry')
    if (viaGet) return viaGet
  } catch {
    /* service not registered under that name; fall through */
  }
  try {
    if (ctx.workspaceRegistry) return ctx.workspaceRegistry
  } catch {
    /* ignore */
  }
  return undefined
}
