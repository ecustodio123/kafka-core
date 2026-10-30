export type ImageStage = 'selected' | 'validated' | 'read' | 'decoded' | 'converted' | 'hashed'
export type ImageTaskOptions = { signal?: AbortSignal; stage?: (stage: ImageStage) => void }
export const IMAGE_TIMEOUTS = { read: 5000, header: 3000, decode: 15000, fallback: 8000, encode: 10000, total: 45000 }
export function checkImageTask(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Preparacion cancelada.', 'AbortError')
}
// Cancellation releases owned resources; late native results must be discarded by their owner.
export function imageTask<T>(start: (resolve: (value: T) => void, reject: (error: unknown) => void) => void,
  milliseconds: number, signal?: AbortSignal, cleanup: () => void = () => {}): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: T | undefined, error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      try { cleanup() } catch { try { console.warn('image_operation', { category: 'resource_cleanup_failed' }) } catch { /* Optional diagnostics. */ } }
      if (error !== undefined) reject(error); else resolve(value as T)
    }
    const abort = () => finish(undefined, signal?.reason ?? new DOMException('Preparacion cancelada.', 'AbortError'))
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => finish(undefined, new Error('La preparacion tardo demasiado. Selecciona otra imagen o vuelve a intentarlo.')), milliseconds)
    try { start(value => finish(value), error => finish(undefined, error)) } catch (error) { finish(undefined, error) }
  })
}
export function readImageBytes(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
  let reader: FileReader | undefined
  return imageTask((resolve, reject) => {
    if (typeof FileReader === 'undefined') { void blob.arrayBuffer().then(resolve, reject); return }
    reader = new FileReader()
    reader.onload = () => reader?.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('No se pudo leer la imagen.'))
    reader.onerror = () => reject(new Error('No se pudo leer la imagen seleccionada.'))
    reader.readAsArrayBuffer(blob)
  }, IMAGE_TIMEOUTS.read, signal, () => {
    if (reader) { reader.onload = null; reader.onerror = null; if (reader.readyState === FileReader.LOADING) reader.abort() }
  })
}
