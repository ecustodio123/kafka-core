import { inspectProductImageHeader, MAX_PRODUCT_IMAGE_BYTES, PRODUCT_IMAGE_LIMITS } from './productImageHeader.ts'
import type { ImageDimensions } from './productImageHeader.ts'

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const MAX_ORIGINAL_IMAGE_BYTES = 60 * 1024 * 1024

export function validateImageFile(file: File, maxSizeBytes = MAX_ORIGINAL_IMAGE_BYTES) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error('Selecciona una imagen JPG, PNG o WebP.')
  }
  if (!file.size) throw new Error('Selecciona una imagen que no este vacia.')

  if (file.size > maxSizeBytes) {
    throw new Error(
      `La imagen debe pesar como maximo ${Math.round(maxSizeBytes / 1024 / 1024)} MB.`,
    )
  }
}

async function checkHeader(bytes: Uint8Array, mime: string, maxDimension = PRODUCT_IMAGE_LIMITS.maxDimension) {
  try {
    if (typeof document === 'undefined') return await inspectProductImageHeader(bytes, mime, maxDimension)
    const worker = new Worker(new URL('./productImageHeader.worker.ts', import.meta.url), { type: 'module' })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<ImageDimensions>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('header timeout')), 3000)
        worker.onmessage = event => event.data?.valid === true && event.data.dimensions
          ? resolve(event.data.dimensions) : reject(new Error('header'))
        worker.onerror = event => { event.preventDefault(); reject(new Error('header worker')) }
        worker.postMessage({ bytes, mime, maxDimension }, [bytes.buffer as ArrayBuffer])
      })
    } finally { clearTimeout(timer); worker.terminate() }
  } catch {
    throw new Error('Imagen invalida o demasiado grande: maximo 16384 px por lado y 64 megapixeles.')
  }
}

// All upload flows validate compressed input before decoding and validate the
// optimized bytes before Storage. Conversion failures never fall back to input.
export async function optimizeImage(
  file: File,
  maxBytes = MAX_PRODUCT_IMAGE_BYTES,
  convert: typeof convertImageToWebp = convertImageToWebp,
): Promise<Blob> {
  validateImageFile(file)
  const dimensions = await checkHeader(new Uint8Array(await file.arrayBuffer()), file.type)
  const attempts = [
    { quality: 0.80, outputDimension: 1200 },
    { quality: 0.70, outputDimension: 1000 },
    { quality: 0.60, outputDimension: 800 },
  ]
  for (const [index, attempt] of attempts.entries()) {
    const blob = await convert(file, { ...PRODUCT_IMAGE_LIMITS, ...attempt,
      dimensions, forceReencode: index > 0 || file.size > maxBytes })
    if (blob.type !== 'image/webp' || !blob.size) throw new Error('No se pudo preparar un WebP valido.')
    if (blob.size > maxBytes) continue
    await checkHeader(new Uint8Array(await blob.arrayBuffer()), blob.type, attempt.outputDimension)
    return blob
  }
  throw new Error(`No se pudo reducir la imagen a ${Math.round(maxBytes / 1024 / 1024)} MB. Selecciona una imagen mas sencilla o de menor resolucion.`)
}

export type ImageConversionLimits = {
  maxDimension: number
  maxPixels: number
  outputDimension: number
  quality?: number
  forceReencode?: boolean
  dimensions?: ImageDimensions
}

export async function convertImageToWebp(file: File, limits: ImageConversionLimits = PRODUCT_IMAGE_LIMITS): Promise<Blob> {
  validateImageFile(file)
  const dimensions = limits.dimensions ?? await checkHeader(new Uint8Array(await file.arrayBuffer()), file.type)
  const scale = Math.min(1, limits.outputDimension / Math.max(dimensions.width, dimensions.height))
  const width = Math.max(1, Math.round(dimensions.width * scale))
  const height = Math.max(1, Math.round(dimensions.height * scale))
  const large = Math.max(dimensions.width, dimensions.height) > 4096 || dimensions.width * dimensions.height > 12_000_000
  let image: ImageBitmap | HTMLImageElement
  if (typeof createImageBitmap === 'function') {
    try { image = await loadResizedBitmap(file, width, height) }
    catch (error) {
      if (large) throw error
      image = await loadImage(file)
    }
  } else {
    if (large) throw new Error('Este navegador no puede reducir esta imagen de forma segura. Prueba otro navegador o una imagen de menor resolucion.')
    image = await loadImage(file)
  }
  const canvas = document.createElement('canvas')
  try {
    // Decode first to reject truncated/invalid files, but preserve already-sized
    // WebP bytes (quality, transparency and hashes) without another lossy encode.
    if (file.type === 'image/webp' && scale === 1 && !limits.forceReencode) return file
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('No se pudo preparar la imagen para subirla.')
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height)

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob || !blob.size || blob.type !== 'image/webp') {
            reject(new Error('No se pudo convertir la imagen a WebP.'))
            return
          }

          resolve(blob)
        },
        'image/webp',
        limits.quality ?? 0.80,
      )
    })
  } finally {
    canvas.width = 0
    canvas.height = 0
    if ('close' in image) image.close()
    else image.src = ''
  }
}

function loadResizedBitmap(file: File, width: number, height: number): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./imageResize.worker.ts', import.meta.url), { type: 'module' })
    const fail = () => reject(new Error('No se pudo procesar la imagen de forma segura en este dispositivo. Prueba una imagen de menor resolucion.'))
    const timer = setTimeout(() => { worker.terminate(); fail() }, 15000)
    worker.onmessage = event => {
      clearTimeout(timer)
      worker.terminate()
      const bitmap = event.data?.bitmap as ImageBitmap | undefined
      if (!bitmap || bitmap.width !== width || bitmap.height !== height) { bitmap?.close(); fail() }
      else resolve(bitmap)
    }
    worker.onerror = event => { event.preventDefault(); clearTimeout(timer); worker.terminate(); fail() }
    try { worker.postMessage({ file, width, height }) }
    catch { clearTimeout(timer); worker.terminate(); fail() }
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
