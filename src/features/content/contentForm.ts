import type { ModuleKind, ModuleRecord } from '../../types/database.ts'

export type ContentForm = { heading: string; title: string; description: string; sort_order: string; is_active: boolean }
export type ContentInput = { heading: string; title: string | null; description: string | null; sort_order: number; is_active: boolean }
export const emptyContentForm: ContentForm = { heading: '', title: '', description: '', sort_order: '0', is_active: true }

export function contentHeading(kind: ModuleKind, record: ModuleRecord) {
  return kind === 'staff' ? record.name ?? '' : record.title ?? ''
}
export function contentForm(kind: ModuleKind, record: ModuleRecord): ContentForm {
  return { heading: contentHeading(kind, record), title: kind === 'staff' ? record.title ?? '' : '',
    description: record.description ?? '', sort_order: String(record.sort_order ?? 0), is_active: record.is_active === true }
}
export function parseContentForm(kind: ModuleKind, form: ContentForm): ContentInput {
  const heading = form.heading.trim(), title = form.title.trim(), description = form.description.trim()
  if (!heading) throw new Error(kind === 'staff' ? 'El nombre es obligatorio.' : 'El titulo es obligatorio.')
  // Conservative UI limits, not assumptions about undocumented database constraints.
  if (heading.length > 200 || title.length > 200) throw new Error('El nombre, titulo o cargo no puede superar 200 caracteres.')
  if (description.length > 5000) throw new Error('La descripcion no puede superar 5000 caracteres.')
  if (!/^-?\d+$/.test(form.sort_order.trim())) throw new Error('El orden debe ser un numero entero.')
  const order = Number(form.sort_order)
  if (!Number.isSafeInteger(order) || order < -2147483648 || order > 2147483647) throw new Error('El orden esta fuera del rango permitido.')
  return { heading, title: kind === 'staff' ? title || null : null, description: description || null, sort_order: order, is_active: form.is_active === true }
}
