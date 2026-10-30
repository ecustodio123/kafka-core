import { productUuid } from './productCompatibility.ts'
export type DiagnosticStage = 'selected' | 'validated' | 'read' | 'decoded' | 'converted' | 'hashed'
  | 'upload_started' | 'upload_completed' | 'associated' | 'failed' | 'canceled' | 'interrupted_unknown'
export type ImageDiagnosticEntry = { id: string; stage: DiagnosticStage; at: number }
const stages: DiagnosticStage[] = ['selected', 'validated', 'read', 'decoded', 'converted', 'hashed', 'upload_started', 'upload_completed', 'associated', 'failed', 'canceled', 'interrupted_unknown']
const ttl = 24 * 60 * 60 * 1000
// Local only; no raw errors, filenames, product data, source URLs or credentials.
export function imageDiagnostics(userId: string, storeId: number) {
  const key = `kafka.image-diagnostic.${userId}.${storeId}`
  let entries: ImageDiagnosticEntry[] = []
  try {
    const raw = sessionStorage.getItem(key)
    if (raw && raw.length < 8192) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) entries = parsed.filter((e): e is ImageDiagnosticEntry => e && typeof e.id === 'string'
        && /^[a-f0-9-]{36}$/.test(e.id) && stages.includes(e.stage)
        && Number.isFinite(e.at) && e.at > Date.now() - ttl && e.at <= Date.now()).slice(-16).map(e => ({ id: e.id, stage: e.stage, at: e.at }))
    }
    if (raw) {
      if (entries.length) sessionStorage.setItem(key, JSON.stringify(entries))
      else sessionStorage.removeItem(key)
    }
  } catch { /* Diagnostics never block editing. */ }
  let lastRelevant = [...entries].reverse().find(e => e.stage !== 'canceled') ?? null
  function write(id: string, stage: DiagnosticStage) {
    if (stage !== 'canceled') lastRelevant = { id, stage, at: Date.now() }
    entries = [...entries.filter(e => e.at > Date.now() - ttl), { id, stage, at: Date.now() }].slice(-16)
    try { sessionStorage.setItem(key, JSON.stringify(entries)) } catch { /* Best effort. */ }
    if (stage === 'failed' || stage === 'interrupted_unknown') { try { console.warn('image_operation', { id, stage }) } catch { /* Optional console. */ } }
  }
  return {
    recover() {
      try {
        const last = entries.length ? entries[entries.length - 1] : undefined
        if (last && !['hashed', 'associated', 'failed', 'canceled', 'interrupted_unknown'].includes(last.stage)) write(last.id, 'interrupted_unknown')
      } catch { /* Never fail a React effect for diagnostics. */ }
    },
    start() {
      let id: string
      try { id = productUuid() } catch { return { stage: (_stage: DiagnosticStage) => {} } }
      try { write(id, 'selected') } catch { /* Diagnostics are optional. */ }
      return { stage: (stage: DiagnosticStage) => { try { write(id, stage) } catch { /* Optional. */ } } }
    },
    snapshot() { return lastRelevant ? { ...lastRelevant } : null },
    incident(error: unknown, info: unknown, module: IncidentModule = 'products') {
      return recordUIIncident(error, info, module, lastRelevant, key)
    },
  }
}

export type IncidentModule = 'app' | 'products'
export type UIIncident = {
  id: string; at: number; module: IncidentModule; version: string; category: string; message: string
  components: string[]; frames: { asset: string; line: number; column: number }[]
  browser: string; os: string; image: ImageDiagnosticEntry | null; correlation: 'context_only'
}
let incidentSequence = 0
function incidentId() {
  try { return `KC-${productUuid()}` } catch {
    // Non-security fallback: diagnostic identifiers never authorize an operation.
    incidentSequence++
    let stamp = 'unknown'
    try { stamp = Date.now().toString(36) } catch { /* Identifier fallback must not throw. */ }
    return `KC-LOCAL-${stamp}-${incidentSequence}`
  }
}
function safeProperty(value: unknown, key: string): string {
  try {
    const result = value && (typeof value === 'object' || typeof value === 'function') ? (value as Record<string, unknown>)[key] : null
    return typeof result === 'string' ? result.slice(0, 4096) : ''
  } catch { return '' }
}
function incidentVersion() {
  try {
    const version = import.meta.env?.VITE_APP_BUILD_ID
    return typeof version === 'string' && /^[a-f0-9]{7,40}$/.test(version) ? version : 'unknown'
  } catch { return 'unknown' }
}
export function recordUIIncident(error: unknown, info: unknown, module: IncidentModule = 'app',
  image: ImageDiagnosticEntry | null = null, scope = 'kafka.image-diagnostic.app'): UIIncident {
  // Never retain error/ErrorInfo, their raw message, stack or arbitrary enumerable properties.
  const incident: UIIncident = { id: incidentId(), at: 0, module: module === 'products' ? 'products' : 'app',
    version: 'unknown', category: 'react_boundary', message: 'Error de interfaz no identificado.',
    components: [], frames: [], browser: 'unknown', os: 'unknown', image: null, correlation: 'context_only' }
  try {
    incident.at = Date.now()
    incident.version = incidentVersion()
    const name = safeProperty(error, 'name')
    const known: Record<string, string> = { TypeError: 'type_error', ReferenceError: 'reference_error', RangeError: 'range_error',
      SecurityError: 'platform_access_denied', QuotaExceededError: 'storage_quota', Error: 'javascript_error' }
    if (Object.prototype.hasOwnProperty.call(known, name)) incident.category = known[name]
    incident.message = `Fallo de interfaz: ${incident.category}.`
    // Known API markers only; never copy a substring from an arbitrary error message.
    const message = safeProperty(error, 'message')
    for (const api of ['scrollIntoView', 'matchMedia', '.at']) {
      if (message.includes(api) && message.includes('not a function')) {
        incident.category = 'unsupported_api'; incident.message = `API secundaria no disponible: ${api === '.at' ? 'Array.at' : api}.`; break
      }
    }
    const componentStack = safeProperty(info, 'componentStack')
    const names = ['ProductsEditor', 'ProductForm', 'ProductTable', 'ProductImage', 'RecoveryBoundary', 'App', 'StoreWorkspace', 'RatingStars', 'DiscountFields']
    incident.components = names.filter(name => new RegExp('\\b' + name + '\\b').test(componentStack)).slice(0, 8)
    // Only own hashed bundle names and numeric locations, no origins, paths, queries or raw stack.
    const expression = /\/assets\/((?:index|png|jpg|webp|utils|imageResize\.worker|productImageHeader\.worker)-[A-Za-z0-9_-]{6,16}\.js):(\d{1,7}):(\d{1,7})/g
    const stack = safeProperty(error, 'stack')
    let match: RegExpExecArray | null
    while (incident.frames.length < 6 && (match = expression.exec(stack))) {
      incident.frames.push({ asset: match[1], line: Number(match[2]), column: Number(match[3]) })
    }
    if (image && /^[a-f0-9-]{36}$/.test(image.id) && stages.includes(image.stage) && Number.isFinite(image.at)) {
      incident.image = { id: image.id, stage: image.stage, at: image.at }
    }
    let ua = ''
    try { ua = navigator.userAgent.slice(0, 512) } catch { /* Optional. */ }
    const browser = /(EdgA?|EdgiOS)\/(\d{1,3})/.exec(ua) ?? /(Firefox|FxiOS)\/(\d{1,3})/.exec(ua) ?? /(Chrome|CriOS)\/(\d{1,3})/.exec(ua) ?? /(Version)\/(\d{1,3})/.exec(ua)
    if (browser) incident.browser = `${browser[1] === 'Version' ? 'Safari' : browser[1]} ${browser[2]}`
    incident.os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown'
  } catch { /* Even exotic native errors must leave the recovery UI usable. */ }
  try {
    const key = `${scope}.incidents`
    const raw = sessionStorage.getItem(key)
    // Keep only the current sanitized incident; never re-persist untrusted stored objects.
    if (raw && raw.length > 16384) sessionStorage.removeItem(key)
    const serialized = JSON.stringify(incident)
    if (serialized.length <= 8192) sessionStorage.setItem(key, serialized)
  } catch { /* The boundary also retains the sanitized report in memory. */ }
  try { console.error('ui_incident', incident) } catch { /* Optional console must not break recovery. */ }
  return incident
}
