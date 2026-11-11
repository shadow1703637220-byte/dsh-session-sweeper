import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isSafeSessionId, planBatch, scanSessions, trashSessions } from '../lib/core.js'

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sweeper-test-'))
  const dshHome = join(root, '.dsh')
  const trashDir = join(root, 'Trash')
  const mk = async (project, id, bytes, ageDays, { lock = false } = {}) => {
    const dir = join(dshHome, 'sessions', project, id)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    await writeFile(file, Buffer.alloc(bytes, 120))
    const when = new Date(Date.now() - ageDays * 86400000)
    await utimes(file, when, when)
    if (lock) await writeFile(join(dir, 'write.lock'), 'x')
    return dir
  }
  await mk('proj-a', 'sess-big', 5000, 40)
  await mk('proj-a', 'sess-mid', 2000, 5)
  await mk('proj-b', 'sess-live', 1000, 0, { lock: true })
  await mkdir(join(dshHome, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(
    join(dshHome, 'storages', 'session_projcache', 'sessions', 'sess-big.json'),
    JSON.stringify({ title: '大块头会话', totalTokens: 123456 }),
  )
  await mkdir(join(dshHome, 'storages'), { recursive: true })
  await writeFile(join(dshHome, 'storages', 'workspace.json'), JSON.stringify({ archivedSessionIds: ['sess-mid'] }))
  return { dshHome, trashDir }
}

test('scan ranks by size desc and reads projcache + registry flags', async () => {
  const { dshHome } = await makeFixture()
  const { sessions, totalBytes } = await scanSessions(dshHome)
  assert.equal(sessions.length, 3)
  assert.equal(sessions[0].sessionId, 'sess-big')
  assert.equal(sessions[0].title, '大块头会话')
  assert.equal(sessions[0].tokens, 123456)
  assert.ok(sessions[0].ageDays >= 39)
  assert.equal(totalBytes, 8001) // 8000 of logs + 1 byte write.lock
  assert.equal(sessions.find((s) => s.sessionId === 'sess-live').live, true)
  assert.equal(sessions.find((s) => s.sessionId === 'sess-mid').archived, true)
})

test('planBatch applies presets', async () => {
  const { dshHome } = await makeFixture()
  const { sessions } = await scanSessions(dshHome)
  assert.deepEqual(planBatch(sessions, { olderThanDays: 30 }).map((s) => s.sessionId), ['sess-big'])
  assert.deepEqual(planBatch(sessions, { archivedOnly: true }).map((s) => s.sessionId), ['sess-mid'])
  assert.deepEqual(planBatch(sessions, { largerThanBytes: 3000 }).map((s) => s.sessionId), ['sess-big'])
  // v0.1.2: onlyNotLive no longer filters anything out (live is info-only)
  assert.deepEqual(planBatch(sessions, { onlyNotLive: true }).map((s) => s.sessionId), ['sess-big', 'sess-mid', 'sess-live'])
})

test('trashSessions moves dirs to trash (live included), skips not-found/invalid, writes audit', async () => {
  const { dshHome, trashDir } = await makeFixture()
  const result = await trashSessions(dshHome, ['sess-big', 'sess-live', 'sess-nope', '../evil'], { trashDir })
  assert.equal(result.moved.length, 2)
  assert.deepEqual(result.moved.map((m) => m.sessionId), ['sess-big', 'sess-live'])
  assert.equal(result.freedBytes, 6001) // 5000 big + 1000 live log + 1 byte write.lock
  assert.deepEqual(
    result.skipped.map((s) => s.reason).sort(),
    ['invalid-id', 'not-found'],
  )
  await stat(join(trashDir, 'sess-big', 'session.v4.jsonl.zstd'))
  await stat(join(trashDir, 'sess-big.json')) // projcache followed it into trash
  await stat(join(trashDir, 'sess-live', 'session.v4.jsonl.zstd'))
  const audit = await readFile(join(dshHome, 'sweeper', 'audit.jsonl'), 'utf8')
  assert.match(audit, /sess-big/)
  const after = await scanSessions(dshHome)
  assert.equal(after.sessions.length, 1)
  assert.equal(after.sessions[0].sessionId, 'sess-mid')
})

test('trashSessions ignores currentSessionId (confirmation is the only gate)', async () => {
  const { dshHome, trashDir } = await makeFixture()
  const result = await trashSessions(dshHome, ['sess-mid'], { trashDir, currentSessionId: 'sess-mid' })
  assert.equal(result.moved.length, 1)
  assert.equal(result.moved[0].sessionId, 'sess-mid')
  assert.equal(result.skipped.length, 0)
})

test('trashSessions runs afterMove per moved session (with live flag), never for skipped', async () => {
  const { dshHome, trashDir } = await makeFixture()
  const seen = []
  const result = await trashSessions(dshHome, ['sess-live', 'sess-nope'], {
    trashDir,
    afterMove: async (entry, target) => { seen.push([entry.sessionId, target.live]) },
  })
  assert.equal(result.moved.length, 1)
  assert.deepEqual(seen, [['sess-live', true]])
  assert.deepEqual(result.accountingFailures, [])
})

test('trashSessions records accounting failures without rolling back the move', async () => {
  const { dshHome, trashDir } = await makeFixture()
  const result = await trashSessions(dshHome, ['sess-big'], {
    trashDir,
    afterMove: async () => { throw new Error('registry down') },
  })
  assert.equal(result.moved.length, 1)
  assert.equal(result.moved[0].accountingError, 'registry down')
  assert.deepEqual(result.accountingFailures, [{ sessionId: 'sess-big', message: 'registry down' }])
  await stat(join(trashDir, 'sess-big', 'session.v4.jsonl.zstd')) // file stayed in trash
  const audit = await readFile(join(dshHome, 'sweeper', 'audit.jsonl'), 'utf8')
  assert.match(audit, /registry down/)
})

test('trashSessions never calls afterMove when the move itself fails', async () => {
  const { dshHome, trashDir } = await makeFixture()
  await writeFile(trashDir, 'not a directory') // mkdir inside moveToTrash will fail
  let called = 0
  const result = await trashSessions(dshHome, ['sess-big'], {
    trashDir,
    afterMove: async () => { called += 1 },
  })
  assert.equal(result.moved.length, 0)
  assert.equal(result.skipped[0].reason, 'io')
  assert.equal(called, 0)
})

test('isSafeSessionId rejects traversal', () => {
  assert.equal(isSafeSessionId('abc-123_X.y'), true)
  assert.equal(isSafeSessionId('../x'), false)
  assert.equal(isSafeSessionId('a/b'), false)
  assert.equal(isSafeSessionId('..'), false)
})
