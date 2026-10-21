import { getSupabaseClient } from '../lib/supabase'
import type { ModuleKind, ModuleRecord } from '../types/database'
import type { ContentInput } from '../features/content/contentForm'

function scoped(record: ModuleRecord, storeId: number) {
  if (record.store_id !== storeId) throw new Error('La respuesta no corresponde a la tienda seleccionada.')
  return record
}
function failed() { return new Error('No se confirmo la operacion. Revisa la conexion, los permisos y si el modulo sigue habilitado.') }

export async function listModuleContent(kind: ModuleKind, storeId: number): Promise<ModuleRecord[]> {
  const { data, error } = await getSupabaseClient().from(kind).select()
    .eq('store_id', storeId).order('sort_order').order('id')
  if (error) throw failed()
  return (data ?? []).map(record => scoped(record, storeId))
}
export async function readModuleContent(kind: ModuleKind, storeId: number, id: string): Promise<ModuleRecord | null> {
  const { data, error } = await getSupabaseClient().from(kind).select().eq('store_id', storeId).eq('id', id).maybeSingle()
  if (error) throw failed()
  return data ? scoped(data, storeId) : null
}
function payload(kind: ModuleKind, input: ContentInput) {
  const common = { description: input.description, sort_order: input.sort_order, is_active: input.is_active }
  return kind === 'staff' ? { ...common, name: input.heading, title: input.title } : { ...common, title: input.heading }
}
export async function createModuleContent(kind: ModuleKind, storeId: number, input: ContentInput): Promise<ModuleRecord> {
  const client = getSupabaseClient()
  const query = kind === 'staff'
    ? client.from('staff').insert({ store_id: storeId, name: input.heading, title: input.title, description: input.description, sort_order: input.sort_order, is_active: input.is_active })
    : client.from('services').insert({ store_id: storeId, title: input.heading, description: input.description, sort_order: input.sort_order, is_active: input.is_active })
  const { data, error } = await query.select().single()
  if (error || !data) throw failed()
  return scoped(data, storeId)
}
export async function updateModuleContent(kind: ModuleKind, storeId: number, id: string, input: ContentInput): Promise<ModuleRecord> {
  const { data, error } = await getSupabaseClient().from(kind).update(payload(kind, input))
    .eq('store_id', storeId).eq('id', id).select().single()
  if (error || !data) throw failed()
  return scoped(data, storeId)
}
export async function setModuleActive(kind: ModuleKind, storeId: number, id: string, active: boolean): Promise<ModuleRecord> {
  const { data, error } = await getSupabaseClient().from(kind).update({ is_active: active })
    .eq('store_id', storeId).eq('id', id).select().single()
  if (error || !data) throw failed()
  return scoped(data, storeId)
}
export async function deleteModuleContent(kind: ModuleKind, storeId: number, id: string) {
  const { data, error } = await getSupabaseClient().from(kind).delete().eq('store_id', storeId).eq('id', id).select('id')
  if (error || data?.length !== 1) throw failed()
}
export async function linkModuleImage(kind: ModuleKind, storeId: number, id: string, expected: string | null, candidate: string | null): Promise<ModuleRecord> {
  let query = getSupabaseClient().from(kind).update({ image_url: candidate }).eq('store_id', storeId).eq('id', id)
  query = expected === null ? query.is('image_url', null) : query.eq('image_url', expected)
  const { data, error } = await query.select().maybeSingle()
  if (!error && data) return scoped(data, storeId)
  const current = await readModuleContent(kind, storeId, id)
  if (current && current.image_url === candidate) return current
  if (current && current.image_url !== expected) throw new Error('Otra sesion cambio la imagen. Recarga el registro antes de continuar.')
  throw failed()
}
