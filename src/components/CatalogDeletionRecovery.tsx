import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { cleanupMessage, deleteCatalogEntity, pendingCatalogDeletions } from '../services/catalogDeletion'
import type { CatalogKind } from '../services/catalogDeletion'

export function CatalogDeletionRecovery({ storeId, kind, revision, disabled, onDeleted, onBusyChange }: {
  storeId: number; kind: CatalogKind; revision: number; disabled: boolean; onDeleted: (id: string) => void
  onBusyChange: (busy: boolean) => void
}) {
  const [ids, setIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    void pendingCatalogDeletions(storeId, kind).then(next => { if (current) setIds(next) }).catch(() => {
      if (current) setMessage('No se pudo consultar la recuperacion local de eliminaciones.')
    })
    return () => { current = false }
  }, [storeId, kind, revision])
  async function retry(id: string) {
    if (inFlight.current || disabled || !window.confirm('Reintentar esta eliminacion pendiente y la limpieza segura de sus imagenes?')) return
    inFlight.current = true
    setBusy(true)
    onBusyChange(true)
    try {
      const result = await deleteCatalogEntity(storeId, kind, id)
      if (result.deleted) onDeleted(id)
      setMessage(cleanupMessage(result))
      setIds(await pendingCatalogDeletions(storeId, kind))
    } catch { setMessage('No se confirmo el reintento. La operacion conserva su identidad; revisa la configuracion backend.') }
    finally { inFlight.current = false; setBusy(false); onBusyChange(false) }
  }
  if (!ids.length && !message) return null
  return <div className="mb-4 space-y-2 border-l-4 border-amber-500 bg-amber-50 p-3 text-sm">
    {ids.map(id => <div key={id} className="flex flex-wrap items-center gap-3"><span>Eliminacion o limpieza pendiente: {id}</span>
      <button type="button" disabled={busy || disabled} onClick={() => void retry(id)} className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 disabled:opacity-50"><RefreshCw size={16} />Reintentar</button></div>)}
    {message && <p role="status">{message}</p>}
  </div>
}
