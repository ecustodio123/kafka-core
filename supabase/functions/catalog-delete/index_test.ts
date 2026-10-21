import { createHandler } from './index.ts'

function equal(a: unknown, b: unknown) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`Expected ${JSON.stringify(b)}, received ${JSON.stringify(a)}`) }
const job = '00000000-0000-4000-8000-000000000001'
const claimToken = '00000000-0000-4000-8000-000000000002'
const body = { action: 'delete', store_id: 1, kind: 'product', entity_id: '7', operation_id: '00000000-0000-4000-8000-000000000003' }
const path = '1-local/products/7-local/principal-local.webp'
function fixture() {
  let record = true, claimed = false, removed = false
  const calls = { deletes: 0, removes: 0, targets: [] as string[], rpcs: [] as string[] }
  const behavior = { storageError: false, storageThrows: false, dbError: false, finishError: false, shared: false, noImage: false,
    unverified: false, nonempty: false, loseDbReply: false }
  const client = {
    auth: { getUser: async (token: string) => ({ data: { user: ['owner', 'other'].includes(token) ? { id: token } : null }, error: null }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.rpcs.push(name)
      if (args.p_actor !== 'owner' || args.p_store !== 1) return { data: null, error: { code: '42501' } }
      if (name === 'delete_catalog_entity') {
        if (behavior.dbError) return { data: null, error: { code: 'XX000' } }
        if (behavior.nonempty) return { data: null, error: { code: '23503' } }
        const replayed = !record
        if (record) { calls.deletes++; record = false }
        if (behavior.loseDbReply) { behavior.loseDbReply = false; throw new Error('local lost SQL reply') }
        return { data: { deleted: true, replayed, cleanup: behavior.unverified ? 'retained_unverified' : behavior.noImage ? 'no_image' : 'pending' }, error: null }
      }
      if (name === 'catalog_image_cleanup_jobs') return { data: behavior.noImage || behavior.unverified || removed ? [] : [job], error: null }
      if (name === 'claim_catalog_image_cleanup') {
        if (behavior.shared) return { data: { acquired: false, state: 'retained_shared' }, error: null }
        if (claimed) return { data: { acquired: false, state: 'deleting' }, error: null }
        claimed = true
        return { data: { acquired: true, bucket: 'product-images', path, claim_token: claimToken }, error: null }
      }
      if (name === 'finish_catalog_image_cleanup') {
        if (behavior.finishError) return { data: null, error: { code: 'XX000' } }
        removed = args.p_success === true
        claimed = false
        return { data: true, error: null }
      }
      throw new Error('unexpected RPC')
    },
    storage: { from: (bucket: string) => ({ remove: async (paths: string[]) => {
      equal(bucket, 'product-images'); equal(paths, [path]); calls.removes++; calls.targets.push(...paths)
      if (behavior.storageThrows) throw new Error('local network error')
      return { error: behavior.storageError ? { message: 'local private provider details' } : null }
    } }) },
  }
  const config = { enabled: true, cleanup: true, origins: ['https://admin.example.test'], storageOrigin: 'https://local-test.supabase.co' }
  const handler = createHandler(config, client)
  const request = (overrides = {}, token = 'owner') => handler(new Request('https://edge.example.test/catalog-delete', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: config.origins[0] },
    body: JSON.stringify({ ...body, ...overrides }),
  }))
  return { calls, behavior, config, request, handler, releaseLease: () => { claimed = false } }
}

Deno.test('delete is committed before Storage; output contains no private target or claim', async () => {
  const f = fixture(), response = await f.request(), text = await response.text()
  equal(response.status, 200); equal(JSON.parse(text), { deleted: true, replayed: false, cleanup: 'complete' })
  equal(f.calls.deletes, 1); equal(f.calls.removes, 1)
  equal(text.includes(path) || text.includes(claimToken), false)
})
Deno.test('unauthenticated and other-tenant requests cannot reach Storage or delete', async () => {
  for (const [token, payload, status] of [['invalid', {}, 401], ['other', {}, 403], ['owner', { store_id: 2 }, 403]] as const) {
    const f = fixture(); equal((await f.request(payload, token)).status, status); equal(f.calls.deletes + f.calls.removes, 0)
  }
})
Deno.test('nonempty category and failed PostgreSQL writes leave Storage untouched', async () => {
  for (const mode of ['nonempty', 'dbError'] as const) {
    const f = fixture(); f.behavior[mode] = true
    equal((await f.request({ kind: 'category', entity_id: job })).status, mode === 'nonempty' ? 409 : 503)
    equal(f.calls.deletes + f.calls.removes, 0)
  }
})
Deno.test('no-image and unverified/external references never invoke Storage.remove', async () => {
  for (const mode of ['noImage', 'unverified'] as const) {
    const f = fixture(); f.behavior[mode] = true
    equal((await (await f.request()).json()).cleanup, mode === 'unverified' ? 'retained_unverified' : 'complete')
    equal(f.calls.removes, 0)
  }
})
Deno.test('shared reference is preserved even though record deletion succeeded', async () => {
  const f = fixture(); f.behavior.shared = true
  equal((await (await f.request()).json()).cleanup, 'retained_shared'); equal(f.calls.removes, 0); equal(f.calls.deletes, 1)
})
for (const mode of ['storageError', 'storageThrows'] as const) {
  Deno.test(`${mode}: partial failure is explicit and replay retries only the same retired file`, async () => {
    const f = fixture(); f.behavior[mode] = true
    const first = await (await f.request()).json()
    equal(first.deleted, true); equal(first.cleanup, 'pending')
    f.behavior[mode] = false
    const second = await (await f.request()).json()
    equal(second.replayed, true); equal(second.cleanup, 'complete'); equal(f.calls.deletes, 1)
    equal(f.calls.targets, [path, path])
  })
}
Deno.test('lost delete reply preserves server idempotency and creates no second deletion', async () => {
  const f = fixture(); f.behavior.loseDbReply = true
  equal((await f.request()).status, 503)
  equal((await (await f.request()).json()).replayed, true); equal(f.calls.deletes, 1)
})
Deno.test('final SQL acknowledgment failure is pending; expired claim can resume idempotent Storage removal', async () => {
  const f = fixture(); f.behavior.finishError = true
  equal((await (await f.request()).json()).cleanup, 'pending')
  await f.request(); equal(f.calls.removes, 1)
  f.behavior.finishError = false; f.releaseLease()
  equal((await (await f.request()).json()).cleanup, 'complete'); equal(f.calls.deletes, 1)
})
Deno.test('simultaneous requests do not acquire two cleanup claims', async () => {
  const f = fixture()
  await Promise.all([f.request(), f.request()])
  equal(f.calls.deletes, 1); equal(f.calls.removes, 1)
})
Deno.test('replacement cleanup never deletes a catalog record or accepts browser file targets', async () => {
  const f = fixture()
  equal((await f.request({ action: 'cleanup' })).status, 200); equal(f.calls.deletes, 0); equal(f.calls.removes, 1)
  equal((await f.request({ bucket: 'other', path: 'other' })).status, 400)
})
Deno.test('independent flags default disabled; method, CORS and oversized/invalid requests fail before writes', async () => {
  const f = fixture(); f.config.enabled = false
  equal((await f.request()).status, 503); equal(f.calls.rpcs.length, 0)
  f.config.enabled = true
  equal((await f.request({ entity_id: '../bad' })).status, 400)
  equal((await f.request({ entity_id: 'x'.repeat(10000) })).status, 400)
  equal((await f.handler(new Request('https://edge.example.test', { method: 'POST', headers: { origin: 'https://foreign.test' } }))).status, 403)
  equal(f.calls.deletes, 0)
})
Deno.test('disabled cleanup never invokes Storage even after a confirmed record deletion', async () => {
  const f = fixture(); f.config.cleanup = false
  const result = await (await f.request()).json()
  equal(result.deleted, true); equal(result.cleanup, 'pending'); equal(f.calls.removes, 0)
})
Deno.test('no-image operation completes without enabling physical cleanup when no old jobs exist', async () => {
  const f = fixture(); f.config.cleanup = false; f.behavior.noImage = true
  equal((await (await f.request()).json()).cleanup, 'complete'); equal(f.calls.removes, 0)
})
