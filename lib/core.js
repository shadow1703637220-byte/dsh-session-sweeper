/**
 * Core filesystem logic for dsh-session-sweeper.
 *
 * Pure Node built-ins, no DSH imports: this module is unit-testable outside
 * the harness with a fake $DSH_HOME tree. Everything destructive in the
 * plugin funnels through `trashSessions`, and nothing here ever unlinks a
 * session artifact — removal means "move into the macOS Trash" (or, off
 * macOS / in tests, into a caller-provided trash directory).
 */
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readdir, readFile, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Session ids are single path segments; anything else is refused. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/

export function isSafeSessionId(id) {
  return typeof id === 'string' && SAFE_ID.test(id) && id !== '.' && id !== '..'
}

export function resolveDshHome(config = {}) {
  if (typeof config.dshHome === 'string' && config.dshHome.length > 0) return resolve(config.dshHome)
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}

async function dirBytes(root) {
  let total = 0
  let latestMtimeMs = 0
  let lockMtimeMs = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
      } else if (entry.isFile()) {
        try {
          const info = await stat(path)
          total += info.size
          if (info.mtimeMs > latestMtimeMs) latestMtimeMs = info.mtimeMs
          if (entry.name.endsWith('.lock') && info.mtimeMs > lockMtimeMs) lockMtimeMs = info.mtimeMs
        } catch {
          /* file vanished mid-scan; ignore */
        }
      }
    }
  }
  return { bytes: total, latestMtimeMs, lockMtimeMs }
}

async function readProjcache(dshHome, sessionId) {
  const path = join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return {
      path,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      tokens: typeof parsed.totalTokens === 'number' ? parsed.totalTokens : undefined,
    }
  } catch {
    return { path, title: undefined, tokens: undefined }
  }
}

/**
 * Scan every stored session and return the ranking, biggest first.
 * Layout: $DSH_HOME/sessions/<project-key>/<session-id>/
 */
/** Best-effort: pull archived/pinned id sets out of the workspace storage. */
async function readRegistrySets(dshHome) {
  const archived = new Set()
  const pinned = new Set()
  const collect = (node, key, set) => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item, key, set)
    } else if (node && typeof node === 'object') {
      if (Array.isArray(node[key])) for (const id of node[key]) if (typeof id === 'string') set.add(id)
      for (const value of Object.values(node)) collect(value, key, set)
    }
  }
  try {
    const parsed = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
    collect(parsed, 'archivedSessionIds', archived)
    collect(parsed, 'pinnedSessionIds', pinned)
  } catch {
    /* registry file absent or reshaped: flags stay unknown, never guessed */
  }
  return { archived, pinned }
}

export async function scanSessions(dshHome, { now = Date.now(), liveWindowMs = 10 * 60 * 1000 } = {}) {
  const sessionsRoot = join(dshHome, 'sessions')
  const registry = await readRegistrySets(dshHome)
  const results = []
  let projects = []
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return { sessionsRoot, sessions: [], totalBytes: 0 }
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(sessionsRoot, project.name)
    let entries = []
    try {
      entries = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeSessionId(entry.name)) continue
      const dir = join(projectDir, entry.name)
      const { bytes, latestMtimeMs, lockMtimeMs } = await dirBytes(dir)
      const cache = await readProjcache(dshHome, entry.name)
      results.push({
        sessionId: entry.name,
        projectKey: project.name,
        dir,
        projcachePath: cache.path,
        title: cache.title ?? entry.name,
        tokens: cache.tokens,
        bytes,
        lastActiveMs: latestMtimeMs,
        ageDays: latestMtimeMs > 0 ? Math.max(0, (now - latestMtimeMs) / 86400000) : undefined,
        // Informational only (UI hint / status column); never a delete gate.
        live: lockMtimeMs > 0 && now - lockMtimeMs < liveWindowMs,
        archived: registry.archived.has(entry.name),
        pinned: registry.pinned.has(entry.name),
      })
    }
  }
  results.sort((a, b) => b.bytes - a.bytes)
  return { sessionsRoot, sessions: results, totalBytes: results.reduce((sum, s) => sum + s.bytes, 0) }
}

/** Rule presets for batch selection. Returns the subset matching `rule`. */
export function planBatch(sessions, rule = {}) {
  return sessions.filter((s) => {
    if (rule.ids) return rule.ids.includes(s.sessionId)
    if (typeof rule.olderThanDays === 'number' && !(s.ageDays !== undefined && s.ageDays >= rule.olderThanDays)) return false
    if (typeof rule.largerThanBytes === 'number' && !(s.bytes >= rule.largerThanBytes)) return false
    if (rule.archivedOnly && !s.archived) return false
    // v0.1.2: `onlyNotLive` is accepted for compatibility but no longer
    // filters — the user decided (2026-11-11) that a confirmed delete
    // applies to live sessions too; `live` is an informational flag only.
    return true
  })
}

async function uniqueTrashPath(trashDir, name) {
  let candidate = join(trashDir, name)
  for (let i = 2; i < 100; i++) {
    try {
      await stat(candidate)
      candidate = join(trashDir, `${name} ${i}`)
    } catch {
      return candidate
    }
  }
  return join(trashDir, `${name} ${Date.now()}`)
}

/** Move one path into the macOS Trash via Finder (keeps "Put Back"). */
async function moveViaFinder(path) {
  const script = `tell application "Finder" to delete POSIX file ${JSON.stringify(path)}`
  await execFileAsync('osascript', ['-e', script])
}

/**
 * Move a path to the trash. On macOS, Finder first, rename into ~/.Trash as
 * fallback. Elsewhere (and in tests) `trashDir` is required.
 * Returns the destination path/name the artifact ended up under.
 */
export async function moveToTrash(path, { trashDir, platform = process.platform } = {}) {
  if (platform === 'darwin' && !trashDir) {
    try {
      await moveViaFinder(path)
      return { destination: join(homedir(), '.Trash', basename(path)), via: 'finder' }
    } catch {
      /* fall through to the rename fallback */
    }
    const fallbackDir = join(homedir(), '.Trash')
    await mkdir(fallbackDir, { recursive: true })
    const destination = await uniqueTrashPath(fallbackDir, basename(path))
    await rename(path, destination)
    return { destination, via: 'rename' }
  }
  if (!trashDir) throw new Error('sweeper/trash-unavailable: no trash directory available on this platform')
  await mkdir(trashDir, { recursive: true })
  const destination = await uniqueTrashPath(trashDir, basename(path))
  await rename(path, destination)
  return { destination, via: 'rename' }
}

/**
 * Trash a batch of sessions (by id). Since v0.1.2 there is no live /
 * current-session protection: the user's explicit confirmation in the UI
 * is the only gate, and any session state can be trashed. Unknown ids,
 * unsafe ids and out-of-root paths are still skipped with a reason, never
 * silently dropped. A session counts as moved only after its log
 * directory actually left the store; the projection cache follows it.
 *
 * v0.1.3: after a session's files are safely in the Trash, an optional
 * `options.afterMove(entry, target)` hook releases the host-side
 * accounting (workspace registry detach etc.) so the sidebar row
 * disappears immediately, without a restart. The hook runs strictly
 * after the move: if the move fails the hook is never called, and if the
 * hook fails the files are NOT rolled back — the failure is recorded on
 * the entry (`accountingError`), in the returned `accountingFailures`,
 * and in the audit log, and the list self-heals on the next restart.
 */
export async function trashSessions(dshHome, sessionIds, options = {}) {
  const { sessions } = await scanSessions(dshHome, options)
  const byId = new Map(sessions.map((s) => [s.sessionId, s]))
  const moved = []
  const skipped = []
  const accountingFailures = []
  for (const id of sessionIds) {
    if (!isSafeSessionId(id)) {
      skipped.push({ sessionId: id, reason: 'invalid-id' })
      continue
    }
    const target = byId.get(id)
    if (!target) {
      skipped.push({ sessionId: id, reason: 'not-found' })
      continue
    }
    // Containment: the resolved dir must stay inside the sessions root.
    const rel = relative(resolve(join(dshHome, 'sessions')), resolve(target.dir))
    if (rel.startsWith('..')) {
      skipped.push({ sessionId: id, reason: 'unsafe-path' })
      continue
    }
    try {
      const main = await moveToTrash(target.dir, options)
      let cacheMoved = false
      try {
        await stat(target.projcachePath)
        await moveToTrash(target.projcachePath, {
          ...options,
          // projcache files share one flat name space in Trash; prefix them
          trashDir: options.trashDir,
        })
        cacheMoved = true
      } catch {
        /* no projcache on disk is normal */
      }
      const entry = {
        sessionId: id,
        title: target.title,
        bytes: target.bytes,
        destination: main.destination,
        via: main.via,
        projcacheMoved: cacheMoved,
      }
      moved.push(entry)
      if (typeof options.afterMove === 'function') {
        try {
          await options.afterMove(entry, target)
        } catch (error) {
          entry.accountingError = error instanceof Error ? error.message : String(error)
          accountingFailures.push({ sessionId: id, message: entry.accountingError })
        }
      }
    } catch (error) {
      skipped.push({ sessionId: id, reason: 'io', message: error instanceof Error ? error.message : String(error) })
    }
  }
  if (options.audit !== false && (moved.length > 0 || skipped.length > 0)) {
    try {
      const auditDir = join(dshHome, 'sweeper')
      await mkdir(auditDir, { recursive: true })
      await appendFile(
        join(auditDir, 'audit.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), action: 'trash-batch', moved, skipped, accountingFailures }) + '\n',
        'utf8',
      )
    } catch {
      /* auditing must never fail the operation itself */
    }
  }
  return { moved, skipped, accountingFailures, freedBytes: moved.reduce((sum, m) => sum + m.bytes, 0) }
}
