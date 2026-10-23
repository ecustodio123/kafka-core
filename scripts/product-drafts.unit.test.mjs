import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearProductDrafts, productDrafts } from '../src/features/products/productDraft.ts'

const form = { name: 'BORRADOR', description: 'Descripcion', price: '20.00', discount_active: false,
  discount_price: '', visual_rating: '5', category_id: '', available: true }
function storage() {
  const map = new Map()
  return { get length() { return map.size }, key: i => [...map.keys()][i] ?? null,
    getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }
}
const input = (productId = null) => ({ productId, form, baseline: productId ? form : null, imagePending: true })

test('refresh recovers all editable fields and only an image-pending boolean', () => {
  const s = storage()
  const saved = productDrafts(s, 'user', 1).save(input(), null)
  assert.deepEqual(productDrafts(s, 'user', 1).latest(), saved)
  assert.deepEqual(Object.keys(saved).sort(), ['baseline', 'form', 'imagePending', 'productId', 'revision', 'storeId', 'userId', 'version'])
  assert.deepEqual(saved.form, form)
})
test('drafts are isolated by actual user, store, create/edit and product', () => {
  const s = storage(); const drafts = productDrafts(s, 'user', 1)
  drafts.save(input(), null); drafts.save(input(7), null)
  assert.equal(productDrafts(s, 'other-user', 1).latest(), null)
  assert.equal(productDrafts(s, 'user', 2).latest(), null)
  assert.equal(drafts.load(8), null)
  assert.equal(drafts.load(null).productId, null)
  assert.equal(drafts.load(7).productId, 7)
})
test('a stale writer or completion never overwrites or deletes a newer draft', () => {
  const s = storage(); const drafts = productDrafts(s, 'user', 1)
  const first = drafts.save(input(7), null)
  const next = drafts.save({ ...input(7), form: { ...form, name: 'NEWER' } }, first)
  assert.throws(() => drafts.save(input(7), first), /cambio/)
  drafts.clear(first)
  assert.deepEqual(drafts.latest(), next)
  drafts.clear(next)
  assert.equal(drafts.latest(), null)
})
test('explicit discard and logout remove drafts without touching unrelated storage', () => {
  const s = storage(); s.setItem('unrelated', 'keep')
  const a = productDrafts(s, 'user', 1); const b = productDrafts(s, 'other', 2)
  a.save(input(), null); b.save(input(7), null)
  a.clearUser(); assert.equal(a.latest(), null); assert.ok(b.latest())
  clearProductDrafts(s); assert.equal(b.latest(), null); assert.equal(s.getItem('unrelated'), 'keep')
})
test('late image preparation cannot recreate a draft after logout or explicit discard', () => {
  const s = storage(); const drafts = productDrafts(s, 'user', 1)
  const pending = drafts.save(input(), null)
  clearProductDrafts(s)
  assert.throws(() => drafts.save(input(), pending), /descartado/)
  assert.equal(drafts.latest(), null)
})
test('corrupt or incomplete drafts are never restored', () => {
  const s = storage(); const drafts = productDrafts(s, 'user', 1)
  drafts.save(input(), null)
  s.setItem('kafka.product-draft.user.1.create', '{')
  assert.equal(drafts.latest(), null)
})
