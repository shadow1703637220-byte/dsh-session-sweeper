import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/**
 * Integration-style timing test for the v0.1.3 field failure:
 * `workspaceRegistry` is NOT ready when the bundle's effect activates.
 * The hook must be absent before the ctx.inject callback fires (deletes
 * still work, rows would refresh on restart) and installed afterwards
 * (deletes detach from the registry immediately).
 */
async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sweeper-index-test-'))
  const dshHome = join(root, '.dsh')
  const trashDir = join(root, 'Trash')
  for (const id of ['sess-early', 'sess-late']) {
    const dir = join(dshHome, 'sessions', 'proj-a', id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(100, 120))
  }
  return { dshHome, trashDir }
}

function makeHost() {
  const host = { route: null, effectFn: null, injectCall: null, disposed: [] }
  const webServer = {
    register: (route) => {
      host.route = route
      return () => host.disposed.push('route')
    },
  }
  host.ctx = {
    get: (name) => (name === 'webServer' ? webServer : undefined),
    effect: (fn) => { host.effectFn = fn },
    inject: (deps, cb) => {
      host.injectCall = { deps, cb }
      return () => host.disposed.push('inject')
    },
  }
  return host
}

async function postTrash(host, sessionIds) {
  const body = Buffer.from(JSON.stringify({ sessionIds }))
  const request = {
    method: 'POST',
    url: '/.dsh-session-sweeper/trash',
    headers: {},
    async *[Symbol.asyncIterator]() { yield body },
  }
  let ended = null
  const response = {
    headersSent: false,
    writeHead() { this.headersSent = true },
    end(payload) { ended = JSON.parse(payload) },
    destroy() {},
  }
  host.route.handler(request, response)
  const deadline = Date.now() + 5000
  while (!ended && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  assert.ok(ended, 'route handler never responded')
  return ended
}

test('hook installs only when workspaceRegistry becomes ready via ctx.inject', async () => {
  const { dshHome, trashDir } = await makeFixture()
  const host = makeHost()
  apply(host.ctx, { dshHome, trashDir })
  const cleanup = host.effectFn()

  // ctx.inject was asked for the registry, but it has not fired yet.
  assert.deepEqual(host.injectCall.deps, ['workspaceRegistry'])

  // Delete before readiness: files move, no accounting happens, no failure.
  const early = await postTrash(host, ['sess-early'])
  assert.equal(early.ok, true)
  assert.equal(early.moved.length, 1)
  assert.deepEqual(early.accountingFailures, [])

  // Registry becomes ready now.
  const calls = []
  const workspace = {
    sessionIds: ['sess-late'],
    async detachSession(id) {
      calls.push(`detach:${id}`)
      this.sessionIds = this.sessionIds.filter((s) => s !== id)
    },
  }
  const registry = {
    list: () => [workspace],
    async unarchiveSession(id) { calls.push(`unarchive:${id}`) },
    async unpinSession(id) { calls.push(`unpin:${id}`) },
    async stopSessionActivity(id) { calls.push(`stop:${id}`) },
  }
  host.injectCall.cb({ workspaceRegistry: registry })

  // Delete after readiness: the registry hook runs and detaches.
  const late = await postTrash(host, ['sess-late'])
  assert.equal(late.ok, true)
  assert.equal(late.moved.length, 1)
  assert.deepEqual(late.accountingFailures, [])
  assert.deepEqual(calls, ['detach:sess-late', 'unarchive:sess-late', 'unpin:sess-late'])
  assert.deepEqual(workspace.sessionIds, [])

  cleanup()
  assert.deepEqual(host.disposed.sort(), ['inject', 'route'])
})
