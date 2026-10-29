export type DiagnosticStage = 'selected' | 'validated' | 'read' | 'decoded' | 'converted' | 'hashed'
  | 'upload_started' | 'upload_completed' | 'associated' | 'failed' | 'canceled' | 'interrupted_unknown'
type Entry = { id: string; stage: DiagnosticStage; at: number }
const stages: DiagnosticStage[] = ['selected', 'validated', 'read', 'decoded', 'converted', 'hashed', 'upload_started', 'upload_completed', 'associated', 'failed', 'canceled', 'interrupted_unknown']
const ttl = 24 * 60 * 60 * 1000
// Local only; no raw errors, filenames, product data, source URLs or credentials.
export function imageDiagnostics(userId: string, storeId: number) {
  const key = `kafka.image-diagnostic.${userId}.${storeId}`
  let entries: Entry[] = []
  try {
    const raw = sessionStorage.getItem(key)
    if (raw && raw.length < 8192) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) entries = parsed.filter((e): e is Entry => e && typeof e.id === 'string'
        && /^[a-f0-9-]{36}$/.test(e.id) && stages.includes(e.stage)
        && Number.isFinite(e.at) && e.at > Date.now() - ttl && e.at <= Date.now()).slice(-16).map(e => ({ id: e.id, stage: e.stage, at: e.at }))
    }
    if (raw) {
      if (entries.length) sessionStorage.setItem(key, JSON.stringify(entries))
      else sessionStorage.removeItem(key)
    }
  } catch { /* Diagnostics never block editing. */ }
  function write(id: string, stage: DiagnosticStage) {
    entries = [...entries.filter(e => e.at > Date.now() - ttl), { id, stage, at: Date.now() }].slice(-16)
    try { sessionStorage.setItem(key, JSON.stringify(entries)) } catch { /* Best effort. */ }
    if (stage === 'failed' || stage === 'interrupted_unknown') console.warn('image_operation', { id, stage })
  }
  return {
    recover() {
      const last = entries.at(-1)
      if (last && !['hashed', 'associated', 'failed', 'canceled', 'interrupted_unknown'].includes(last.stage)) write(last.id, 'interrupted_unknown')
    },
    start() { const id = crypto.randomUUID(); write(id, 'selected'); return { stage: (stage: DiagnosticStage) => write(id, stage) } },
  }
}
