import { useCallback, useEffect, useRef, useState } from 'react'
import { getStoreFeatures, saveStoreFeatures } from '../services/storeFeatures'
import type { ModuleFlags, StoreFeatures } from '../types/database'

export function useStoreFeatures(storeId: number) {
  const [state, setState] = useState<{ loading: boolean; row: StoreFeatures | null; error: string | null }>({ loading: true, row: null, error: null })
  const [saving, setSaving] = useState(false)
  const sequence = useRef(0)
  const busy = useRef(false)
  const reload = useCallback(async () => {
    if (busy.current) return
    const request = ++sequence.current
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const row = await getStoreFeatures(storeId)
      if (request === sequence.current) setState({ loading: false, row, error: null })
    } catch {
      if (request === sequence.current) setState({ loading: false, row: null, error: 'No se pudo consultar la configuracion de modulos.' })
    }
  }, [storeId])
  useEffect(() => {
    const requests = sequence
    let mounted = true
    void Promise.resolve().then(() => { if (mounted) void reload() })
    return () => { mounted = false; requests.current++ }
  }, [reload])
  async function save(flags: ModuleFlags) {
    if (busy.current || state.loading || state.error) return
    busy.current = true
    setSaving(true)
    const request = ++sequence.current
    try {
      const row = await saveStoreFeatures(storeId, state.row, flags)
      if (request === sequence.current) setState({ loading: false, row, error: null })
    } finally {
      busy.current = false
      if (request === sequence.current) setSaving(false)
    }
  }
  return { ...state, saving, reload, save }
}
