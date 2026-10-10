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

export async function convertImageToWebp(file: File): Promise<Blob> {
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
