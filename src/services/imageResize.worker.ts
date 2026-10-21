// Probe resize support on a tiny bitmap before decoding an untrusted large file.
// A successful promise alone does not prove the browser honored resize options.
self.onmessage = async (event: MessageEvent) => {
  let bitmap: ImageBitmap | undefined
  try {
    if (typeof createImageBitmap !== 'function') throw new Error('unsupported')
    const bytes = Uint8Array.from(atob('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'), c => c.charCodeAt(0))
    const probe = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), { resizeWidth: 2, resizeHeight: 2 })
    const supported = probe.width === 2 && probe.height === 2
    probe.close()
    if (!supported) throw new Error('unsupported')
    const { file, width, height } = event.data
    bitmap = await createImageBitmap(file, {
      resizeWidth: width, resizeHeight: height, resizeQuality: 'high', imageOrientation: 'from-image',
    })
    if (bitmap.width !== width || bitmap.height !== height) throw new Error('resize')
    self.postMessage({ bitmap }, { transfer: [bitmap] })
    bitmap = undefined
  } catch {
    self.postMessage({ failed: true })
  } finally { bitmap?.close() }
}
