export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024
export const PRODUCT_IMAGE_LIMITS = { maxDimension: 4096, maxPixels: 12_000_000, outputDimension: 2048 }

export async function inspectProductImageHeader(bytes: Uint8Array, mime: string, maxDimension: number) {
  const parser = mime === 'image/png' ? (await import('image-size/types/png')).PNG
    : mime === 'image/jpeg' ? (await import('image-size/types/jpg')).JPG
    : mime === 'image/webp' ? (await import('image-size/types/webp')).WEBP : null
  if (!parser?.validate(bytes)) throw new Error('format')
  const { width, height } = parser.calculate(bytes)
  if (!width || !height || width > maxDimension || height > maxDimension
    || width * height > PRODUCT_IMAGE_LIMITS.maxPixels) throw new Error('dimensions')
}
