import { productAbortController } from './productCompatibility.ts'
import { checkImageTask, imageTask, readImageBytes, IMAGE_TIMEOUTS, type ImageTaskOptions } from './imageTask.ts'
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

// JPEG metadata can precede dimensions. Bound its scan instead of allocating the entire 60 MiB original.
export const MAX_IMAGE_HEADER_BYTES = 1024 * 1024
async function checkHeader(blob: Blob, mime: string, maxDimension = PRODUCT_IMAGE_LIMITS.maxDimension, signal?: AbortSignal) {
  const bytes = new Uint8Array(await readImageBytes(blob.slice(0, MAX_IMAGE_HEADER_BYTES), signal))
  checkImageTask(signal)
  if (typeof document === 'undefined') return inspectProductImageHeader(bytes, mime, maxDimension)
  let worker: Worker | undefined
  return imageTask<ImageDimensions>((resolve, reject) => {
    worker = new Worker(new URL('./productImageHeader.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = event => event.data?.valid === true && event.data.dimensions
      ? resolve(event.data.dimensions) : reject(new Error('Imagen invalida, cabecera no compatible o dimensiones excesivas.'))
    worker.onerror = event => { event.preventDefault(); reject(new Error('No se pudo verificar la imagen en este navegador.')) }
    worker.postMessage({ bytes, mime, maxDimension }, [bytes.buffer as ArrayBuffer])
  }, IMAGE_TIMEOUTS.header, signal, () => worker?.terminate())
}

// All upload flows validate compressed input before decoding and validate the
// optimized bytes before Storage. Conversion failures never fall back to input.
export async function optimizeImage(
  file: File,
  maxBytes = MAX_PRODUCT_IMAGE_BYTES,
  convert: typeof convertImageToWebp = convertImageToWebp,
  options: ImageTaskOptions = {},
): Promise<Blob> {
  const controller = productAbortController()
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()
  const timer = setTimeout(() => controller.abort(new Error('La preparacion tardo demasiado. Selecciona otra imagen.')), IMAGE_TIMEOUTS.total)
  const task = { ...options, signal: controller.signal }
  try {
    checkImageTask(task.signal)
    task.stage?.('selected')
    validateImageFile(file)
    task.stage?.('validated')
    const dimensions = await checkHeader(file, file.type, PRODUCT_IMAGE_LIMITS.maxDimension, task.signal)
    task.stage?.('read')
    const attempts = [
      { quality: 0.80, outputDimension: 1200 },
      { quality: 0.70, outputDimension: 1000 },
      { quality: 0.60, outputDimension: 800 },
    ]
    for (const [index, attempt] of attempts.entries()) {
      const blob = await imageTask<Blob>((resolve, reject) => {
        void convert(file, { ...PRODUCT_IMAGE_LIMITS, ...attempt, dimensions, ...task,
          forceReencode: index > 0 || file.size > maxBytes }).then(resolve, reject)
      }, IMAGE_TIMEOUTS.total, task.signal, () => {})
      checkImageTask(task.signal)
      task.stage?.('converted')
      if (blob.type !== 'image/webp' || !blob.size) throw new Error('No se pudo preparar un WebP valido.')
      if (blob.size > maxBytes) continue
      await checkHeader(blob, blob.type, attempt.outputDimension, task.signal)
      return blob
    }
    throw new Error(`No se pudo reducir la imagen a ${Math.round(maxBytes / 1024 / 1024)} MB. Selecciona una imagen mas sencilla o de menor resolucion.`)
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel) }
}

export type ImageConversionLimits = {
  maxDimension: number
  maxPixels: number
  outputDimension: number
  quality?: number
  forceReencode?: boolean
  dimensions?: ImageDimensions
  signal?: AbortSignal
  stage?: ImageTaskOptions['stage']
}

export async function convertImageToWebp(file: File, limits: ImageConversionLimits = PRODUCT_IMAGE_LIMITS): Promise<Blob> {
  checkImageTask(limits.signal)
  validateImageFile(file)
  const dimensions = limits.dimensions ?? await checkHeader(file, file.type, limits.maxDimension, limits.signal)
  const scale = Math.min(1, limits.outputDimension / Math.max(dimensions.width, dimensions.height))
  const width = Math.max(1, Math.round(dimensions.width * scale))
  const height = Math.max(1, Math.round(dimensions.height * scale))
  const large = Math.max(dimensions.width, dimensions.height) > 4096 || dimensions.width * dimensions.height > 12_000_000
  let image: ImageBitmap | HTMLImageElement
  if (typeof createImageBitmap === 'function') {
    try { image = await loadResizedBitmap(file, width, height, limits.signal) }
    catch (error) {
      checkImageTask(limits.signal)
      if (large) throw error
      image = await loadImage(file, limits.signal)
    }
  } else {
    if (large) throw new Error('Este navegador no puede reducir esta imagen de forma segura. Prueba otro navegador o una imagen de menor resolucion.')
    image = await loadImage(file, limits.signal)
  }
  let canvas: HTMLCanvasElement | undefined
  try {
    checkImageTask(limits.signal)
    limits.stage?.('decoded')
    canvas = document.createElement('canvas')
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

    return await imageTask<Blob>((resolve, reject) => {
      canvas!.toBlob(
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
    }, IMAGE_TIMEOUTS.encode, limits.signal)
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0 }
    if ('close' in image) image.close()
    else image.src = ''
  }
}

function loadResizedBitmap(file: File, width: number, height: number, signal?: AbortSignal): Promise<ImageBitmap> {
  let worker: Worker | undefined
  let active = true
  return imageTask((resolve, reject) => {
    worker = new Worker(new URL('./imageResize.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = event => {
      const bitmap = event.data?.bitmap as ImageBitmap | undefined
      if (!active) { bitmap?.close(); return }
      if (!bitmap || bitmap.width !== width || bitmap.height !== height || signal?.aborted) {
        bitmap?.close(); reject(new Error('No se pudo reducir la imagen de forma segura.'))
      } else resolve(bitmap)
    }
    worker.onerror = event => { event.preventDefault(); reject(new Error('No se pudo procesar la imagen de forma segura.')) }
    worker.postMessage({ file, width, height })
  }, IMAGE_TIMEOUTS.decode, signal, () => { active = false; worker?.terminate() })
}

function loadImage(file: File, signal?: AbortSignal): Promise<HTMLImageElement> {
  let image: HTMLImageElement | undefined
  let imageUrl: string | undefined
  let succeeded = false
  return imageTask((resolve, reject) => {
    image = new Image()
    imageUrl = URL.createObjectURL(file)
    image.onload = () => { succeeded = true; resolve(image!) }
    image.onerror = () => reject(new Error('No se pudo leer la imagen seleccionada.'))
    image.src = imageUrl
  }, IMAGE_TIMEOUTS.fallback, signal, () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl)
    if (image) { image.onload = null; image.onerror = null; if (!succeeded) image.src = '' }
  })
}
