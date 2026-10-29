// Drafts may degrade to memory. Durable operation receipts MUST fail closed.
export function productBrowserStorage() {
  let unavailable = false
  const memory = new Map<string, string>()
  function persistent(): Storage {
    try { return window.sessionStorage } catch { unavailable = true; throw new Error('El almacenamiento local no esta disponible. No cierres la pagina.') }
  }
  const durable = {
    getItem(key: string) { try { return persistent().getItem(key) } catch { unavailable = true; throw new Error('No se puede recuperar la operacion local. No se enviaron nuevos datos.') } },
    setItem(key: string, value: string) { try { persistent().setItem(key, value) } catch { unavailable = true; throw new Error('No se pudo proteger la operacion local. No se enviaron nuevos datos.') } },
    removeItem(key: string) { try { persistent().removeItem(key) } catch { unavailable = true; throw new Error('No se pudo completar el registro local de la operacion. Conserva esta pagina.') } },
  }
  const drafts = {
    get length() { try { return persistent().length } catch { return memory.size } },
    key(index: number) { try { return persistent().key(index) } catch { return [...memory.keys()][index] ?? null } },
    getItem(key: string) {
      if (unavailable) return memory.get(key) ?? null
      try { const value = persistent().getItem(key); if (value !== null) memory.set(key, value); return value }
      catch { unavailable = true; return memory.get(key) ?? null }
    },
    setItem(key: string, value: string) {
      memory.set(key, value)
      try { if (!unavailable) persistent().setItem(key, value) } catch { unavailable = true }
    },
    removeItem(key: string) {
      memory.delete(key)
      try { if (!unavailable) persistent().removeItem(key) } catch { unavailable = true }
    },
  }
  return { drafts, durable, unavailable: () => unavailable }
}
