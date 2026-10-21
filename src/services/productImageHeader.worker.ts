import { inspectProductImageHeader } from './productImageHeader'

self.onmessage = async (event: MessageEvent) => {
  try {
    const dimensions = await inspectProductImageHeader(event.data.bytes, event.data.mime, event.data.maxDimension)
    self.postMessage({ valid: true, dimensions })
  } catch { self.postMessage({ valid: false }) }
}
