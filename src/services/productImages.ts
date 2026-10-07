import { getSupabaseClient } from '../lib/supabase'
import type { Product, Store } from '../types/database'

const PRODUCT_IMAGES_BUCKET = 'product-images'

export function getProductImageUrl(imagePath: string) {
  const { data } = getSupabaseClient()
    .storage
    .from(PRODUCT_IMAGES_BUCKET)
    .getPublicUrl(imagePath)

  return data.publicUrl
}

export async function uploadProductImage({
  file,
  productId,
  storeId,
}: {
  file: File
  productId: Product['id']
  storeId: Store['id']
}) {
  const imageBlob = await convertImageToWebp(file)
  const imagePath = `${storeId}/${productId}/image.webp`

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

async function convertImageToWebp(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Selecciona un archivo de imagen valido.')
  }

  const image = await loadImage(file)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('No se pudo preparar la imagen para subirla.')
  }

  context.drawImage(image, 0, 0)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('No se pudo convertir la imagen a WebP.'))
          return
        }

        resolve(blob)
      },
      'image/webp',
      0.86,
    )
  })
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const imageUrl = URL.createObjectURL(file)

    image.onload = () => {
      URL.revokeObjectURL(imageUrl)
      resolve(image)
    }

    image.onerror = () => {
      URL.revokeObjectURL(imageUrl)
      reject(new Error('No se pudo leer la imagen seleccionada.'))
    }

    image.src = imageUrl
  })
}
