import { getSupabaseClient } from '../lib/supabase'
import { validateImageFile } from './imageProcessing'
import { imageDigest, prepareProductImage } from './productImagePreparation'
import type { PreparedProductImage } from './productImagePreparation'
import { slugifyPathSegment } from './pathSlugs'
import type { ModuleKind, ModuleRecord, Store } from '../types/database'
import { contentHeading } from '../features/content/contentForm'

const maxBytes = 2 * 1024 * 1024
export type ContentImage = { prepared: PreparedProductImage; path: string; url: string; phase: 'prepared' | 'uploading' | 'uploaded' | 'uncertain' }
export function moduleBucket(kind: ModuleKind) { return kind === 'staff' ? 'staff-images' : 'service-images' }
export async function prepareModuleImage(file: File) {
  validateImageFile(file, maxBytes)
  const prepared = await prepareProductImage(file)
  if (prepared.size > maxBytes) throw new Error('El WebP preparado supera el maximo de 2 MB.')
  return prepared
}
export function beginModuleImage(kind: ModuleKind, store: Store, record: ModuleRecord, prepared: PreparedProductImage): ContentImage {
  if (record.store_id !== store.id) throw new Error('La imagen no corresponde a esta tienda.')
  const path = `${store.id}-${slugifyPathSegment(store.slug)}/${kind}/${record.id}-${slugifyPathSegment(contentHeading(kind, record))}/principal-${prepared.selectionId}.webp`
  const { data } = getSupabaseClient().storage.from(moduleBucket(kind)).getPublicUrl(path)
  return { prepared, path, url: data.publicUrl, phase: 'prepared' }
}
export async function ensureModuleImage(kind: ModuleKind, image: ContentImage) {
  const storage = getSupabaseClient().storage.from(moduleBucket(kind))
  if (image.phase === 'prepared') {
    image.phase = 'uploading'
    try {
      const { error } = await storage.upload(image.path, image.prepared.blob, { upsert: false, contentType: 'image/webp', cacheControl: '3600' })
      if (error) throw error
      image.phase = 'uploaded'
    } catch { image.phase = 'uncertain' }
  }
  // Never re-upload after a timeout, even if a subsequent GET returns 404.
  const { data, error } = await storage.download(image.path)
  if (error || !data) throw new Error('No se confirmo la imagen en Storage. Puede faltar la configuracion de buckets/politicas. El registro se conserva; reintenta verificar o guarda sin imagen.')
  if (await imageDigest(await data.arrayBuffer()) !== image.prepared.sha256) throw new Error('La imagen almacenada no coincide. No se sobrescribio ningun archivo.')
  image.phase = 'uploaded'
}
