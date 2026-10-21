export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024
export const PRODUCT_IMAGE_LIMITS = { maxDimension: 16384, maxPixels: 64_000_000, outputDimension: 1200 }
export type ImageDimensions = { width: number; height: number }

export async function inspectProductImageHeader(bytes: Uint8Array, mime: string, maxDimension: number) {
  const parser = mime === 'image/png' ? (await import('image-size/types/png')).PNG
    : mime === 'image/jpeg' ? (await import('image-size/types/jpg')).JPG
    : mime === 'image/webp' ? (await import('image-size/types/webp')).WEBP : null
  if (!parser?.validate(bytes)) throw new Error('format')
  const { width, height, orientation } = parser.calculate(bytes)
  if (!width || !height || width > maxDimension || height > maxDimension
    || width * height > PRODUCT_IMAGE_LIMITS.maxPixels) throw new Error('dimensions')
  return orientation && orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height }
}
