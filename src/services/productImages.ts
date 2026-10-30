import { productUuid, withProductDeadline } from './productCompatibility.ts'
import { getSupabaseClient } from '../lib/supabase'
import { getProduct, setProductImagePath } from './products'
import { imageDigest, MAX_PRODUCT_IMAGE_BYTES } from './productImagePreparation'
import { createProductImageCoordinator, validImageOperation, type ProductImageOperation } from './productImageOperation'

const PRODUCT_IMAGES_BUCKET = 'product-images'

export function getProductImageUrl(imagePath: string) {
  const { data } = getSupabaseClient()
    .storage
    .from(PRODUCT_IMAGES_BUCKET)
    .getPublicUrl(imagePath)

  return data.publicUrl
}

function validateOperation(o: ProductImageOperation) {
  if (!validImageOperation(o, o.ownerId, o.storeId, o.productId)) throw new Error('Operacion no valida.')
}

async function upload(o: ProductImageOperation, blob: Blob) {
  validateOperation(o)
  if (blob.type !== 'image/webp' || blob.size !== o.size || blob.size > MAX_PRODUCT_IMAGE_BYTES
    || await imageDigest(await blob.arrayBuffer()) !== o.sha256) throw new Error('Archivo no coincidente.')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      getSupabaseClient().storage.from(PRODUCT_IMAGES_BUCKET).upload(o.candidatePath, blob, {
        cacheControl: '3600', contentType: 'image/webp', upsert: false,
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Subida incierta.')), 15000) }),
    ])
    if (result.error) throw new Error('No se pudo confirmar la subida.')
  } finally { clearTimeout(timer) }
}

async function verify(o: ProductImageOperation): Promise<'match' | 'absent' | 'different' | 'unknown'> {
  validateOperation(o)
  try {
    return await withProductDeadline(async signal => {
    const { data, error } = await getSupabaseClient().storage.from(PRODUCT_IMAGES_BUCKET)
      .download(o.candidatePath, { cacheNonce: productUuid() }, {
        cache: 'no-store', signal,
      }).asStream()
    if (error) {
      const coded = error as { status?: number; code?: string }
      return coded.status === 404 && coded.code === 'NoSuchKey' ? 'absent' : 'unknown'
    }
    if (!data) return 'unknown'
    const reader = data.getReader()
    const bytes = new Uint8Array(o.size)
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!(value instanceof Uint8Array) || length + value.length > bytes.length) {
          await reader.cancel()
          return 'different'
        }
        bytes.set(value, length)
        length += value.length
      }
    } finally { reader.releaseLock() }
    return length === o.size && await imageDigest(bytes.buffer) === o.sha256 ? 'match' : 'different'
    })
  } catch { return 'unknown' }
}

export function productImageCoordinator(ownerId: string, storeId: number,
  changed: (operation: ProductImageOperation) => void) {
  return createProductImageCoordinator(ownerId, storeId, {
    getItem: (key) => sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
    removeItem: (key) => sessionStorage.removeItem(key),
  }, {
    readProduct: (id) => getProduct(storeId, id), upload, verify,
    link: (o) => setProductImagePath(storeId, o.productId, o.candidatePath, o.expectedPath),
  }, changed)
}
