import { inspectProductImageHeader } from './productImageHeader'

self.onmessage = async (event: MessageEvent) => {
  try {
    await inspectProductImageHeader(event.data.bytes, event.data.mime, event.data.maxDimension)
    self.postMessage({ valid: true })
  } catch { self.postMessage({ valid: false }) }
}
