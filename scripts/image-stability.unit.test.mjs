import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageTask, readImageBytes } from '../src/services/imageTask.ts'
import { optimizeImage, MAX_IMAGE_HEADER_BYTES } from '../src/services/imageProcessing.ts'
import { productBrowserStorage } from '../src/services/productBrowserStorage.ts'
import { imageDiagnostics } from '../src/services/imageDiagnostics.ts'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhX8AAAAASUVORK5CYII=', 'base64')
const webp = new Blob([Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')], { type: 'image/webp' })

test('timeout settles once, cleans resources and ignores a late completion', async () => {
  let late; let clean = 0
  await assert.rejects(imageTask(resolve => { late = resolve }, 10, undefined, () => clean++), /tardo demasiado/)
  late('too late'); assert.equal(clean, 1)
})
test('abort and an already aborted signal never leave work running', async () => {
  const c = new AbortController(); let clean = 0; let started = 0
  const work = imageTask(() => { started++ }, 100, c.signal, () => clean++)
  c.abort(); await assert.rejects(work, { name: 'AbortError' })
  await assert.rejects(imageTask(() => started++, 100, c.signal, () => clean++), { name: 'AbortError' })
  assert.equal(started, 1); assert.equal(clean, 2)
})
test('read failure is propagated without converting or touching a product', async () => {
  await assert.rejects(readImageBytes({ arrayBuffer: async () => { throw new Error('read failed') } }), /read failed/)
})
test('60 MiB original reads only bounded header slices, not the entire original', async () => {
  const file = new File([png, new Uint8Array(60 * 1024 * 1024 - png.length)], 'not logged.png', { type: 'image/png' })
  file.arrayBuffer = () => { throw new Error('full original read forbidden') }
  const native = file.slice.bind(file); const reads = []
  file.slice = (start, end) => { reads.push(end - start); return native(start, end) }
  assert.equal(await optimizeImage(file, undefined, async () => webp), webp)
  assert.ok(reads.every(size => size <= MAX_IMAGE_HEADER_BYTES))
})
test('aborted conversion does not return a prepared image or run another attempt', async () => {
  const c = new AbortController(); let converts = 0
  const work = optimizeImage(new File([png], 'private.png', { type: 'image/png' }), 5e6, async () => {
    converts++; c.abort(); return webp
  }, { signal: c.signal })
  await assert.rejects(work, { name: 'AbortError' }); assert.equal(converts, 1)
})
test('blocked storage getter allows memory-only drafts but durable writes fail closed', () => {
  const previous = globalThis.window
  globalThis.window = Object.defineProperty({}, 'sessionStorage', { get() { throw new DOMException('blocked', 'SecurityError') } })
  try {
    const storage = productBrowserStorage()
    assert.equal(storage.drafts.getItem('draft'), null)
    storage.drafts.setItem('draft', 'safe local draft'); assert.equal(storage.drafts.getItem('draft'), 'safe local draft')
    assert.equal(storage.unavailable(), true)
    assert.throws(() => storage.durable.setItem('operation', 'id'), /No se pudo proteger/)
    storage.drafts.removeItem('draft'); assert.equal(storage.drafts.getItem('draft'), null)
  } finally { globalThis.window = previous }
})
test('diagnostics allow only technical fields, isolate scopes and detect an unknown interruption once', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const records = new Map(); globalThis.sessionStorage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) }
  try {
    imageDiagnostics('user', 1).start().stage('decoded')
    imageDiagnostics('other-user', 1).recover(); imageDiagnostics('user', 2).recover()
    const recovered = imageDiagnostics('user', 1); recovered.recover(); recovered.recover()
    const events = JSON.parse([...records.values()][0])
    assert.equal(events.filter(e => e.stage === 'interrupted_unknown').length, 1)
    assert.ok(events.every(e => Object.keys(e).sort().join(',') === 'at,id,stage'))
    assert.equal(records.size, 1)
  } finally { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage }
})

test('cleanup exceptions cannot prevent a wait from settling safely', async () => {
  const work = imageTask(() => {}, 10, undefined, () => { throw new Error('native cleanup failure') })
  await assert.rejects(work, /tardo demasiado/)
})
test('diagnostics prune expired records and discard unapproved fields on next scoped access', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const key = 'kafka.image-diagnostic.user.1'
  const records = new Map([[key, JSON.stringify([
    { id: crypto.randomUUID(), stage: 'decoded', at: Date.now() - 25 * 60 * 60 * 1000 },
    { id: crypto.randomUUID(), stage: 'hashed', at: Date.now() - 100, unapproved: 'must disappear' },
  ])]])
  globalThis.sessionStorage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) }
  try {
    imageDiagnostics('user', 1).recover()
    const data = JSON.parse(records.get(key))
    assert.equal(data.length, 1); assert.deepEqual(Object.keys(data[0]).sort(), ['at', 'id', 'stage'])
    assert.equal(data[0].stage, 'hashed')
    records.set(key, JSON.stringify([{ id: crypto.randomUUID(), stage: 'decoded', at: Date.now() - 25 * 60 * 60 * 1000 }]))
    imageDiagnostics('user', 1).recover(); assert.equal(records.has(key), false)
  } finally { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage }
})
