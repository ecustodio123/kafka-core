import { getSupabaseClient } from '../lib/supabase'
import { imageDigest } from './productImagePreparation'
import { slugifyPathSegment } from './pathSlugs'
import { readPublication } from './publications'
import type { Publication, Store } from '../types/database'

export const MAX_PUBLICATION_PDF_BYTES = 10 * 1024 * 1024
const bucket = 'publication-files'
export type PreparedPdf = { file: File; id: string; hash: string }
export type PdfUpload = { prepared: PreparedPdf; path: string; phase: 'prepared' | 'attempted' | 'verified' }
export async function preparePublicationPdf(file: File): Promise<PreparedPdf> {
  if (file.type !== 'application/pdf' || !/\.pdf$/i.test(file.name) || !file.size || file.size > MAX_PUBLICATION_PDF_BYTES
    || file.name.length > 255 || [...file.name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('Selecciona un PDF valido de hasta 10 MB con un nombre de hasta 255 caracteres.')
  const bytes = await file.arrayBuffer()
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('El archivo no tiene una cabecera PDF valida.')
  return { file, id: crypto.randomUUID(), hash: await imageDigest(bytes) }
}
export function publicationFilePath(store: Store, row: Publication, documentId: string) {
  if (row.store_id !== store.id || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(row.id)
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(documentId)) throw new Error('Referencia de PDF no valida.')
  return `${store.id}-${slugifyPathSegment(store.slug)}/publications/${row.id}-${slugifyPathSegment(row.slug)}/documento-${documentId}.pdf`
}
export function ownedPublicationPath(path: string, storeId: number, id: string) {
  const p = path.split('/')
  return p.length === 4 && p[0].startsWith(`${storeId}-`) && /^[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p[0])
    && p[1] === 'publications' && p[2].startsWith(`${id}-`)
    && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p[2])
    && /^documento-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.pdf$/.test(p[3])
}
export async function ensurePublicationPdf(upload: PdfUpload) {
  const storage = getSupabaseClient().storage.from(bucket)
  if (upload.phase === 'prepared') {
    upload.phase = 'attempted'
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const { error } = await Promise.race([
        storage.upload(upload.path, upload.prepared.file, { contentType: 'application/pdf', upsert: false, cacheControl: '0' }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Subida no confirmada.')), 15000) }),
      ])
      if (error) throw error
    } catch { /* Lost responses must verify this candidate, never repeat upload. */ }
    finally { clearTimeout(timer) }
  }
  const { data, error } = await storage.download(upload.path, { cacheNonce: crypto.randomUUID() }, { signal: AbortSignal.timeout(15000) })
  if (error || !data || data.size !== upload.prepared.file.size || data.size > MAX_PUBLICATION_PDF_BYTES
    || await imageDigest(await data.arrayBuffer()) !== upload.prepared.hash) throw new Error('No se confirmo el PDF almacenado. Reintenta verificar el mismo archivo; no se enviara otra subida.')
  upload.phase = 'verified'
}
export async function signedPublicationPdf(storeId: number, id: string) {
  const row = await readPublication(storeId, id)
  if (!row?.pdf_storage_path || !ownedPublicationPath(row.pdf_storage_path, storeId, id)) throw new Error('El PDF no esta disponible para esta publicacion.')
  const { data, error } = await getSupabaseClient().storage.from(bucket).createSignedUrl(row.pdf_storage_path, 60)
  if (error || !data?.signedUrl) throw new Error('No se pudo autorizar el acceso al PDF.')
  return data.signedUrl
}
