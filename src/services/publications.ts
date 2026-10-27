import { getSupabaseClient } from '../lib/supabase'
import type { Publication, PublicationInput } from '../types/database'

export const PUBLIC_PUBLICATION_COLUMNS = 'id,store_id,title,slug,summary,category,publication_type,display_order,published_at' as const
function failed(error?: { code?: string } | null): Error {
  return new Error(error?.code === '23505' ? 'Ya existe una publicacion con ese slug en esta tienda.'
    : 'No se confirmo el guardado. Revisa la conexion, los permisos y si Publicaciones sigue habilitado.')
}
function scoped(row: Publication, storeId: number): Publication {
  if (row.store_id !== storeId) throw new Error('La publicacion no corresponde a esta tienda.')
  return row
}
export async function listPublications(storeId: number): Promise<Publication[]> {
  const { data, error } = await getSupabaseClient().from('publications').select().eq('store_id', storeId)
    .order('display_order').order('published_at', { ascending: false, nullsFirst: false }).order('id')
  if (error) throw failed(error)
  return (data ?? []).map(row => scoped(row, storeId))
}
export async function readPublication(storeId: number, id: string): Promise<Publication | null> {
  const { data, error } = await getSupabaseClient().from('publications').select().eq('store_id', storeId).eq('id', id).maybeSingle()
  if (error) throw failed(error)
  return data ? scoped(data, storeId) : null
}
export async function createPublication(storeId: number, id: string, input: PublicationInput): Promise<Publication> {
  // A stable client UUID lets a lost INSERT response recover without a second record.
  const draft = { ...input, status: 'draft' as const }
  const { data, error } = await getSupabaseClient().from('publications').insert({ ...draft, id, store_id: storeId }).select().single()
  if (!error && data) return scoped(data, storeId)
  const current = await readPublication(storeId, id)
  if (current && (Object.keys(draft) as (keyof PublicationInput)[]).every(k => current[k] === draft[k])) return current
  throw failed(error)
}
export async function updatePublication(storeId: number, id: string, input: PublicationInput): Promise<Publication> {
  const { data, error } = await getSupabaseClient().from('publications').update(input).eq('store_id', storeId).eq('id', id).select().single()
  if (error || !data) throw failed(error)
  return scoped(data, storeId)
}
export async function linkPublicationPdf(storeId: number, id: string, expected: string | null,
  pdf: Pick<Publication, 'pdf_storage_path' | 'pdf_original_name' | 'pdf_size_bytes'>): Promise<Publication> {
  let query = getSupabaseClient().from('publications').update(pdf).eq('store_id', storeId).eq('id', id)
  query = expected === null ? query.is('pdf_storage_path', null) : query.eq('pdf_storage_path', expected)
  const { data, error } = await query.select().maybeSingle()
  if (!error && data) return scoped(data, storeId)
  const current = await readPublication(storeId, id)
  if (current && current.pdf_storage_path === pdf.pdf_storage_path && current.pdf_size_bytes === pdf.pdf_size_bytes
    && current.pdf_original_name === pdf.pdf_original_name) return current
  if (current && current.pdf_storage_path !== expected) throw new Error('Otra sesion cambio el PDF. Recarga la publicacion antes de continuar.')
  throw failed(error)
}
export async function deletePublication(storeId: number, id: string): Promise<void> {
  const { data, error } = await getSupabaseClient().from('publications').delete().eq('store_id', storeId).eq('id', id).select('id')
  if (error || data?.length !== 1 || data[0].id !== id) throw failed(error)
}
// Uses the caller's RLS context. Public consumers use their normal anon client;
// never signs PDFs. Bounded pages avoid downloading an unbounded catalog.
export async function listPublishedPublications(storeId: number, offset = 0, limit = 50) {
  if (!Number.isSafeInteger(storeId) || storeId <= 0 || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Consulta de publicaciones no valida.')
  const { data, error } = await getSupabaseClient().from('publications').select(PUBLIC_PUBLICATION_COLUMNS)
    .eq('store_id', storeId).eq('status', 'published').order('display_order')
    .order('published_at', { ascending: false, nullsFirst: false }).order('id').range(offset, offset + limit - 1)
  if (error) throw new Error('No se pudieron consultar las publicaciones publicadas.')
  return data ?? []
}
