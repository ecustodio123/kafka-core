import { productUuid } from './productCompatibility.ts'
import { checkImageTask, imageTask, readImageBytes, IMAGE_TIMEOUTS, type ImageTaskOptions } from './imageTask.ts'
import { convertImageToWebp, optimizeImage } from './imageProcessing.ts'
import { MAX_PRODUCT_IMAGE_BYTES } from './productImageHeader.ts'

export { MAX_PRODUCT_IMAGE_BYTES, PRODUCT_IMAGE_LIMITS } from './productImageHeader.ts'
export type PreparedProductImage = { selectionId: string; blob: Blob; sha256: string; size: number }

export async function imageDigest(bytes: ArrayBuffer) {
  if (typeof crypto === 'undefined' || !crypto.subtle || typeof crypto.subtle.digest !== 'function') throw new Error('Este navegador no permite verificar la imagen de forma segura.')
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function prepareProductImage(
  file: File,
  convert: typeof convertImageToWebp = convertImageToWebp,
  maxOutputBytes = MAX_PRODUCT_IMAGE_BYTES,
  options: ImageTaskOptions = {},
): Promise<PreparedProductImage> {
  const blob = await optimizeImage(file, maxOutputBytes, convert, options)
  const bytes = await readImageBytes(blob, options.signal)
  const sha256 = await imageTask<string>((resolve, reject) => { void imageDigest(bytes).then(resolve, reject) }, IMAGE_TIMEOUTS.read, options.signal)
  checkImageTask(options.signal)
  options.stage?.('hashed')
  return { selectionId: productUuid(), blob, sha256, size: blob.size }
}
