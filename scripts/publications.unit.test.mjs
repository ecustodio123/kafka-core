import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyPublicationForm, parsePublicationForm, publicationForm } from '../src/features/publications/publicationForm.ts'
const form = { ...emptyPublicationForm, title: ' Informe Anual ', slug: '' }
test('publication normalizes title, nullable optional fields and shared slugs; defaults to draft', () => {
  assert.deepEqual(parsePublicationForm(form), { title: 'Informe Anual', slug: 'informe-anual', summary: null,
    category: null, publication_type: 'document', status: 'draft', display_order: 0 })
})
test('explicit slug is retained and article metadata is supported without an editor', () => {
  const parsed = parsePublicationForm({ ...form, slug: 'mi-slug', publication_type: 'article', summary: ' Resumen ', display_order: '-2' })
  assert.equal(parsed.slug, 'mi-slug'); assert.equal(parsed.publication_type, 'article')
  assert.equal(parsed.summary, 'Resumen'); assert.equal(parsed.display_order, -2)
})
test('invalid or oversized form values are rejected before writes', () => {
  for (const patch of [{ title: '' },{ title:'x'.repeat(201) },{ slug:'../other' },{ slug:'A B' },{ slug:'x'.repeat(121) },
    { summary:'x'.repeat(5001) },{ category:'x'.repeat(201) },{ status:'live' },{ publication_type:'javascript' },
    { display_order:'' },{ display_order:'1.5' },{ display_order:'2147483648' },{ display_order:'Infinity' }]) {
    assert.throws(()=>parsePublicationForm({ ...form,...patch }))
  }
})
test('edit preserves status, slug and nullable form semantics without sending timestamps or author', () => {
  const input = parsePublicationForm(publicationForm({ title:'Existing',slug:'original-slug',summary:null,category:null,
    publication_type:'document',status:'archived',display_order:3,published_at:'2026-10-26T00:00:00Z',created_by:'private' }))
  assert.equal(input.status,'archived'); assert.equal(input.slug,'original-slug')
  assert.equal(Object.hasOwn(input,'published_at'),false); assert.equal(Object.hasOwn(input,'created_by'),false)
})
