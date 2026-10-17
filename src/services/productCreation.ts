import type { Product } from '../types/database.ts'

export type ProductCreationInput = {
  name: string
  description: string
  price: number
  discount_active: boolean
  discount_price: number | null
  visual_rating: number | null
  category_id: string | null
  available: boolean
}

export type ProductCreationResult = {
  status: 'found' | 'not_found' | 'deleted'
  product: Product | null
  replayed?: boolean
}

export function productCreationError(error: { code?: string; message: string }) {
  return new Error(error.code === 'PT409'
    ? 'Puede existir una creacion anterior. Vuelve a abrir "Nuevo producto" para intentar recuperarla. Se conserva la operacion pendiente.'
    : error.message)
}

type Transport = (operationId: string, input: ProductCreationInput | null) => Promise<ProductCreationResult>
type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Only an operation UUID is persisted. Catalog text, images and credentials stay
// out of browser storage. A recovery lookup never inserts a product.
export function createProductCreationCoordinator(
  ownerId: string,
  storeId: number,
  storage: PendingStorage,
  transport: Transport,
  newUuid = () => crypto.randomUUID(),
) {
  if (!ownerId || !Number.isSafeInteger(storeId) || storeId <= 0) {
    throw new Error('La tienda de la operacion no es valida.')
  }
  const storageKey = `kafka.product-creation.${ownerId}.${storeId}`
  let busy = false
  let frozenInput: ProductCreationInput | null = null
  let deletedResult = false

  function pendingId() {
    const id = storage.getItem(storageKey)
    if (id !== null && !UUID.test(id)) throw new Error('La operacion pendiente no es valida.')
    return id
  }

  function complete(result: ProductCreationResult) {
    if (result.status === 'deleted') {
      storage.removeItem(storageKey)
      frozenInput = null
      deletedResult = true
      throw new Error('El producto de esta operacion fue eliminado. No se recreara automaticamente.')
    }
    if (result.status !== 'found' || !result.product
      || result.product.store_id !== storeId || !Number.isSafeInteger(result.product.id)
      || result.product.id <= 0) {
      throw new Error('No se pudo confirmar el producto. Conserva la operacion pendiente.')
    }
    storage.removeItem(storageKey)
    frozenInput = null
    return result.product
  }

  return {
    async recover(): Promise<Product | null> {
      if (busy) throw new Error('Ya hay un guardado en curso.')
      busy = true
      try {
        const id = pendingId()
        if (!id) {
          deletedResult = false // A new explicit form opening starts a new logical creation.
          return null
        }
        const result = await transport(id, null)
        if (result.status === 'not_found') {
          // Keep UUID: even if a previously in-flight call commits later, SQL
          // will reject different input rather than insert another product.
          frozenInput = null
          return null
        }
        return complete(result)
      } finally { busy = false }
    },
    async create(input: ProductCreationInput): Promise<Product> {
      if (busy) throw new Error('Ya hay un guardado en curso.')
      busy = true
      try {
        if (deletedResult) throw new Error('El producto fue eliminado. Abre una nueva creacion explicitamente.')
        if (frozenInput && JSON.stringify(frozenInput) !== JSON.stringify(input)) {
          throw new Error('Reintenta con los mismos datos o recupera la creacion pendiente antes de editar.')
        }
        const id = pendingId() ?? newUuid()
        // Fail closed if browser persistence is unavailable, before any RPC.
        storage.setItem(storageKey, id)
        frozenInput ??= { ...input }
        return complete(await transport(id, frozenInput))
      } finally { busy = false }
    },
  }
}
