import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contentForm, emptyContentForm, parseContentForm } from '../src/features/content/contentForm.ts'

for (const kind of ['services', 'staff']) {
  test(`${kind}: required heading, draft default, explicit publication and safe integer order`, () => {
    assert.equal(emptyContentForm.is_active, false)
    assert.throws(() => parseContentForm(kind, emptyContentForm), /obligatorio/)
    const input = parseContentForm(kind, { ...emptyContentForm, heading: '  Local  ', title: '  Doctor  ', description: '  ', sort_order: '-3' })
    assert.deepEqual(input, { heading: 'Local', title: kind === 'staff' ? 'Doctor' : null, description: null, sort_order: -3, is_active: false })
    assert.equal(parseContentForm(kind, { ...emptyContentForm, heading: 'Local', is_active: true }).is_active, true)
    for (const order of ['', '1.2', 'NaN', '1e3', '2147483648', '-2147483649']) {
      assert.throws(() => parseContentForm(kind, { ...emptyContentForm, heading: 'Local', sort_order: order }), /orden/)
    }
  })
  test(`${kind}: nullable editing fields normalize without exposing identity or image fields`, () => {
    const record = { id: 'local', store_id: 1, name: 'Person', title: kind === 'staff' ? null : 'Service', description: null, image_url: 'https://example.com/a.webp', sort_order: 0, is_active: true }
    const result = parseContentForm(kind, contentForm(kind, record))
    assert.equal(result.heading, kind === 'staff' ? 'Person' : 'Service')
    assert.equal(result.description, null)
    const nullable = contentForm(kind, { ...record, sort_order: null, is_active: null })
    assert.equal(nullable.sort_order, '0'); assert.equal(nullable.is_active, false)
    assert.deepEqual(Object.keys(result).sort(), ['description', 'heading', 'is_active', 'sort_order', 'title'])
    assert.throws(() => parseContentForm(kind, { ...emptyContentForm, heading: 'a'.repeat(201) }), /200/)
    assert.throws(() => parseContentForm(kind, { ...emptyContentForm, heading: 'a', description: 'a'.repeat(5001) }), /5000/)
  })
}
