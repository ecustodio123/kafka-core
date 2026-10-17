import { convertImageToWebp, validateImageFile } from './imageProcessing.ts'
import { inspectProductImageHeader, MAX_PRODUCT_IMAGE_BYTES, PRODUCT_IMAGE_LIMITS } from './productImageHeader.ts'

export { MAX_PRODUCT_IMAGE_BYTES, PRODUCT_IMAGE_LIMITS }
export type PreparedProductImage = { selectionId: string; blob: Blob; sha256: string; size: number }

export async function imageDigest(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function checkHeader(bytes: Uint8Array, mime: string, maxDimension = PRODUCT_IMAGE_LIMITS.maxDimension) {
  try {
    if (typeof document === 'undefined') return await inspectProductImageHeader(bytes, mime, maxDimension)
    // Header parsing of hostile compressed data must not block the UI thread.
    // Fail closed in browsers that cannot create the same-origin module worker.
    const worker = new Worker(new URL('./productImageHeader.worker.ts', import.meta.url), { type: 'module' })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('header timeout')), 3000)
        worker.onmessage = (event) => event.data?.valid === true ? resolve() : reject(new Error('header'))
        worker.onerror = (event) => { event.preventDefault(); reject(new Error('header worker')) }
        worker.postMessage({ bytes, mime, maxDimension }, [bytes.buffer as ArrayBuffer])
      })
    } finally { clearTimeout(timer); worker.terminate() }
  } catch {
    throw new Error('Imagen invalida o demasiado grande: maximo 4096 px por lado y 12 megapixeles.')
  }
}

export async function prepareProductImage(
  file: File,
  convert: typeof convertImageToWebp = convertImageToWebp,
): Promise<PreparedProductImage> {
  validateImageFile(file, MAX_PRODUCT_IMAGE_BYTES)
  if (!file.size) throw new Error('Selecciona una imagen que no este vacia.')
  // Bounded compressed input; inspect dimensions BEFORE asking the browser to decode.
  await checkHeader(new Uint8Array(await file.arrayBuffer()), file.type)
  const blob = await convert(file, PRODUCT_IMAGE_LIMITS)
  if (blob.type !== 'image/webp' || !blob.size || blob.size > MAX_PRODUCT_IMAGE_BYTES) {
    throw new Error('No se pudo preparar un WebP valido de hasta 5 MB.')
  }
  const bytes = await blob.arrayBuffer()
  const sha256 = await imageDigest(bytes)
  await checkHeader(new Uint8Array(bytes), blob.type, PRODUCT_IMAGE_LIMITS.outputDimension)
  return { selectionId: crypto.randomUUID(), blob, sha256, size: blob.size }
}
