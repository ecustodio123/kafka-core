import { getSupabaseClient } from '../lib/supabase'
import { convertImageToWebp, validateImageFile } from './imageProcessing'
import { slugifyPathSegment } from './pathSlugs'
import type { Product, Store } from '../types/database'

const PRODUCT_IMAGES_BUCKET = 'product-images'
const MAX_PRODUCT_IMAGE_SIZE_BYTES = 5 * 1024 * 1024

export function getProductImageUrl(imagePath: string) {
  const { data } = getSupabaseClient()
    .storage
    .from(PRODUCT_IMAGES_BUCKET)
    .getPublicUrl(imagePath)

  return data.publicUrl
}

export async function uploadProductImage({
  file,
  productName,
  productId,
  storeSlug,
  storeId,
}: {
  file: File
  productName: Product['name']
  productId: Product['id']
  storeSlug: Store['slug']
  storeId: Store['id']
}) {
  validateImageFile(file, MAX_PRODUCT_IMAGE_SIZE_BYTES)
  const imageBlob = await convertImageToWebp(file)
  const imagePath = [
    `${storeId}-${slugifyPathSegment(storeSlug)}`,
    'products',
    `${productId}-${slugifyPathSegment(productName)}`,
    `principal-${Date.now()}.webp`,
  ].join('/')

  const { error } = await getSupabaseClient()
    .storage
    .from(PRODUCT_IMAGES_BUCKET)
    .upload(imagePath, imageBlob, {
      cacheControl: '3600',
      contentType: 'image/webp',
      upsert: true,
    })

  if (error) {
    throw new Error(`No se pudo subir la imagen: ${error.message}`)
  }

  return imagePath
}
