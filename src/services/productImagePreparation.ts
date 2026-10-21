import { convertImageToWebp, optimizeImage } from './imageProcessing.ts'
import { MAX_PRODUCT_IMAGE_BYTES } from './productImageHeader.ts'

export { MAX_PRODUCT_IMAGE_BYTES, PRODUCT_IMAGE_LIMITS } from './productImageHeader.ts'
export type PreparedProductImage = { selectionId: string; blob: Blob; sha256: string; size: number }

export async function imageDigest(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function prepareProductImage(
  file: File,
  convert: typeof convertImageToWebp = convertImageToWebp,
  maxOutputBytes = MAX_PRODUCT_IMAGE_BYTES,
): Promise<PreparedProductImage> {
  const blob = await optimizeImage(file, maxOutputBytes, convert)
  const bytes = await blob.arrayBuffer()
  const sha256 = await imageDigest(bytes)
  return { selectionId: crypto.randomUUID(), blob, sha256, size: blob.size }
}
