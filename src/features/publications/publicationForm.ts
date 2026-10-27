import { slugifyPathSegment } from '../../services/pathSlugs.ts'
import type { Publication, PublicationInput } from '../../types/database.ts'

export type PublicationForm = {
  title: string; slug: string; summary: string; category: string
  publication_type: Publication['publication_type']; status: Publication['status']; display_order: string
}
export const emptyPublicationForm: PublicationForm = {
  title: '', slug: '', summary: '', category: '', publication_type: 'document', status: 'draft', display_order: '0',
}
export function publicationForm(row: Publication): PublicationForm {
  return { title: row.title, slug: row.slug, summary: row.summary ?? '', category: row.category ?? '',
    publication_type: row.publication_type, status: row.status, display_order: String(row.display_order) }
}
export function parsePublicationForm(form: PublicationForm): PublicationInput {
  const title = form.title.trim(), slug = form.slug.trim() || slugifyPathSegment(title)
  if (!title || title.length > 200) throw new Error('El titulo es obligatorio y admite hasta 200 caracteres.')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) throw new Error('El slug admite hasta 120 caracteres: minusculas, numeros y guiones.')
  if (form.summary.length > 5000 || form.category.length > 200) throw new Error('El resumen admite 5000 caracteres y la categoria 200.')
  if (!['draft', 'published', 'archived'].includes(form.status) || !['document', 'article'].includes(form.publication_type)) throw new Error('Selecciona un estado y tipo validos.')
  const order = Number(form.display_order)
  if (!form.display_order.trim() || !Number.isInteger(order) || order < -2147483648 || order > 2147483647) throw new Error('El orden debe ser un entero valido.')
  return { title, slug, summary: form.summary.trim() || null, category: form.category.trim() || null,
    publication_type: form.publication_type, status: form.status, display_order: order }
}
