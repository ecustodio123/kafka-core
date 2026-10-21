import { getSupabaseClient } from '../lib/supabase'

export type CatalogKind = 'product' | 'category'
export type CatalogDeleteResult = { deleted: boolean; cleanup: 'complete' | 'pending' | 'retained_shared' | 'retained_unverified' }
const prefix = 'kafka.catalog-delete.'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function scope(storeId: number, kind: CatalogKind) {
  const { data } = await getSupabaseClient().auth.getSession()
  if (!data.session || !Number.isSafeInteger(storeId) || storeId <= 0) throw new Error('Inicia sesion nuevamente.')
  return `${prefix}${data.session.user.id}.${storeId}.${kind}.`
}
export async function pendingCatalogDeletions(storeId: number, kind: CatalogKind) {
  const start = await scope(storeId, kind)
  const ids: string[] = []
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i)
    if (!key?.startsWith(start)) continue
    const id = key.slice(start.length)
    if ((kind === 'product' ? /^[1-9][0-9]*$/.test(id) : uuid.test(id)) && uuid.test(sessionStorage.getItem(key) ?? '')) ids.push(id)
  }
  return ids
}
export async function deleteCatalogEntity(storeId: number, kind: CatalogKind, id: string): Promise<CatalogDeleteResult> {
  const key = `${await scope(storeId, kind)}${id}`
  const existing = sessionStorage.getItem(key)
  if (existing && !uuid.test(existing)) throw new Error('No se pudo eliminar. Actualiza la página antes de volver a intentarlo.')
  const operation = existing ?? crypto.randomUUID()
  sessionStorage.setItem(key, operation) // Before HTTP; no payload, image URL or credential is persisted.
  const result = await invoke({ action: 'delete', store_id: storeId, kind, entity_id: id, operation_id: operation })
  if (result.deleted !== true) throw new Error('No se pudo confirmar la eliminación. Actualiza la lista antes de volver a intentarlo.')
  if (['complete', 'retained_unverified'].includes(result.cleanup)) {
    try { sessionStorage.removeItem(key) } catch { /* The confirmed deletion can safely be replayed. */ }
  }
  return result
}
export async function cleanupCatalogImages(storeId: number, kind: CatalogKind, id: string): Promise<CatalogDeleteResult> {
  return invoke({ action: 'cleanup', store_id: storeId, kind, entity_id: id })
}
async function invoke(body: Record<string, unknown>): Promise<CatalogDeleteResult> {
  const { data, error } = await getSupabaseClient().functions.invoke('catalog-delete', { body, timeout: 30000 })
  if (error) {
    if ('context' in error && error.context instanceof Response) {
      try {
        const result = await error.context.json()
        if (result.error === 'La categoria tiene productos o existen referencias que impiden eliminar.') throw new Error('No se puede eliminar la categoría porque tiene productos asociados o está en uso.')
      } catch (caught) { if (caught instanceof Error && caught.message === 'No se puede eliminar la categoría porque tiene productos asociados o está en uso.') throw caught }
    }
    throw new Error('No se pudo confirmar la eliminación. Actualiza la lista antes de volver a intentarlo.')
  }
  if (!data || typeof data.deleted !== 'boolean' || !['complete', 'pending', 'retained_shared', 'retained_unverified'].includes(data.cleanup)) {
    throw new Error('No se pudo confirmar la eliminación. Actualiza la lista antes de volver a intentarlo.')
  }
  return data
}
export function reportCatalogCleanup(result: CatalogDeleteResult) {
  if (result.cleanup !== 'complete') {
    console.warn('Catalog image cleanup requires review.', { status: result.cleanup })
  }
}
