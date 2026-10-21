import { getSupabaseClient } from '../lib/supabase'
import { optimizeImage, validateImageFile } from './imageProcessing'
import { slugifyPathSegment } from './pathSlugs'
import type { Category, Store } from '../types/database'

const CATEGORY_IMAGES_BUCKET = 'category-images'
const MAX_CATEGORY_IMAGE_SIZE_BYTES = 2 * 1024 * 1024

export function validateCategoryImageFile(file: File) {
  validateImageFile(file)
}

export async function prepareCategoryImage(file: File) {
  return optimizeImage(file, MAX_CATEGORY_IMAGE_SIZE_BYTES)
}

export async function uploadCategoryImage({
  categoryId,
  categorySlug,
  file,
  storeSlug,
  storeId,
}: {
  categoryId: Category['id']
  categorySlug: Category['slug']
  file: File
  storeSlug: Store['slug']
  storeId: Store['id']
}) {
  validateCategoryImageFile(file)

  const imageBlob = await prepareCategoryImage(file)
  const imagePath = [
    `${storeId}-${slugifyPathSegment(storeSlug)}`,
    'categories',
    `${categoryId}-${slugifyPathSegment(categorySlug)}`,
    `principal-${Date.now()}.webp`,
  ].join('/')

  const { error } = await getSupabaseClient()
    .storage
    .from(CATEGORY_IMAGES_BUCKET)
    .upload(imagePath, imageBlob, {
      cacheControl: '3600',
      contentType: 'image/webp',
      upsert: false,
    })

  if (error) {
    throw new Error(`No se pudo subir la imagen: ${error.message}`)
  }

  const { data } = getSupabaseClient()
    .storage
    .from(CATEGORY_IMAGES_BUCKET)
    .getPublicUrl(imagePath)

  return {
    imagePath,
    imageUrl: data.publicUrl,
  }
}
