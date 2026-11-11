import assert from 'node:assert/strict'
import test from 'node:test'

import { createReleaseAccounting, resolveWorkspaceRegistry } from '../lib/registry.js'

function mockRegistry({ failDetach = false } = {}) {
  const calls = []
  const workspace = {
    sessionIds: ['sess-a', 'sess-b'],
    async detachSession(id) {
      calls.push(`detach:${id}`)
      if (failDetach) throw new Error('detach boom')
      this.sessionIds = this.sessionIds.filter((s) => s !== id)
    },
  }
  const registry = {
    list: () => [workspace],
    async stopSessionActivity(id) { calls.push(`stop:${id}`) },
    async unarchiveSession(id) { calls.push(`unarchive:${id}`) },
    async unpinSession(id) { calls.push(`unpin:${id}`) },
  }
  return { registry, workspace, calls }
}

test('releaseAccounting: live session is stopped first, then detached/unarchived/unpinned', async () => {
  const { registry, workspace, calls } = mockRegistry()
  const release = createReleaseAccounting(registry)
  await release({ sessionId: 'sess-a' }, { live: true })
  assert.deepEqual(calls, ['stop:sess-a', 'detach:sess-a', 'unarchive:sess-a', 'unpin:sess-a'])
  assert.deepEqual(workspace.sessionIds, ['sess-b'])
})

test('releaseAccounting: non-live session skips stop; unknown workspace holder is fine', async () => {
  const { registry, calls } = mockRegistry()
  const release = createReleaseAccounting(registry)
  await release({ sessionId: 'sess-not-held' }, { live: false })
  assert.deepEqual(calls, ['unarchive:sess-not-held', 'unpin:sess-not-held'])
})

test('releaseAccounting: a failing step does not stop the rest, aggregate error is thrown', async () => {
  const { registry, calls } = mockRegistry({ failDetach: true })
  const release = createReleaseAccounting(registry)
  await assert.rejects(() => release({ sessionId: 'sess-a' }, { live: false }), /detachSession: detach boom/)
  assert.deepEqual(calls, ['detach:sess-a', 'unarchive:sess-a', 'unpin:sess-a'])
})

test('releaseAccounting: missing registry or methods degrades quietly', async () => {
  assert.equal(createReleaseAccounting(undefined), undefined)
  assert.equal(createReleaseAccounting(null), undefined)
  const release = createReleaseAccounting({})
  await release({ sessionId: 'sess-a' }, { live: true })
})

test('resolveWorkspaceRegistry tries ctx.get, then the property form', () => {
  const reg = { marker: 1 }
  assert.equal(resolveWorkspaceRegistry({ get: (name) => (name === 'workspaceRegistry' ? reg : undefined) }), reg)
  assert.equal(resolveWorkspaceRegistry({ get: () => undefined, workspaceRegistry: reg }), reg)
  assert.equal(resolveWorkspaceRegistry({ get: () => { throw new Error('nope') } }), undefined)
  assert.equal(resolveWorkspaceRegistry({}), undefined)
})
