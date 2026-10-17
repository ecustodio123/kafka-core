const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export function validateImageFile(file: File, maxSizeBytes: number) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error('Selecciona una imagen JPG, PNG o WebP.')
  }

  if (file.size > maxSizeBytes) {
    throw new Error(
      `La imagen debe pesar como maximo ${Math.round(maxSizeBytes / 1024 / 1024)} MB.`,
    )
  }
}

export type ImageConversionLimits = {
  maxDimension: number
  maxPixels: number
  outputDimension: number
}

export async function convertImageToWebp(file: File, limits?: ImageConversionLimits): Promise<Blob> {
  const image = await loadImage(file)
  if (limits && (!image.naturalWidth || !image.naturalHeight
    || image.naturalWidth > limits.maxDimension || image.naturalHeight > limits.maxDimension
    || image.naturalWidth * image.naturalHeight > limits.maxPixels)) {
    throw new Error('Las dimensiones de la imagen superan el limite permitido.')
  }
  const canvas = document.createElement('canvas')
  const scale = limits ? Math.min(1, limits.outputDimension / Math.max(image.naturalWidth, image.naturalHeight)) : 1
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('No se pudo preparar la imagen para subirla.')
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        canvas.width = 0
        canvas.height = 0
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
