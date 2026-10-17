import type { Product } from '../types/database.ts'
import { slugifyPathSegment } from './pathSlugs.ts'
import type { PreparedProductImage } from './productImagePreparation.ts'

export type ImagePhase = 'prepared' | 'uploading' | 'uploaded' | 'linking' | 'linked' | 'uncertain' | 'conflict'
export type ProductImageOperation = {
  version: 1; ownerId: string; storeId: number; productId: number; selectionId: string
  candidatePath: string; expectedPath: string | null; sha256: string; size: number
  phase: ImagePhase; uploadAttempted: boolean; uploadConfirmed: boolean
}
export type ImageLinkResult = { status: 'linked' | 'conflict' | 'uncertain'; product: Product | null }
export type ImageOperationResult = ImageLinkResult & { message: string }
export type ImageOperationIO = {
  readProduct: (productId: number) => Promise<Product | null>
  upload: (operation: ProductImageOperation, blob: Blob) => Promise<void>
  verify: (operation: ProductImageOperation) => Promise<'match' | 'absent' | 'different' | 'unknown'>
  link: (operation: ProductImageOperation) => Promise<ImageLinkResult>
}
type MetadataStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const phases: ImagePhase[] = ['prepared', 'uploading', 'uploaded', 'linking', 'linked', 'uncertain', 'conflict']

export function validImageOperation(value: unknown, ownerId: string, storeId: number, productId: number): value is ProductImageOperation {
  if (!value || typeof value !== 'object') return false
  const o = value as ProductImageOperation
  if (Object.keys(o).some((k) => !['version', 'ownerId', 'storeId', 'productId', 'selectionId',
    'candidatePath', 'expectedPath', 'sha256', 'size', 'phase', 'uploadAttempted', 'uploadConfirmed'].includes(k))) return false
  if (o.version !== 1 || o.ownerId !== ownerId || o.storeId !== storeId || o.productId !== productId
    || !Number.isSafeInteger(productId) || productId <= 0
    || typeof o.selectionId !== 'string' || !UUID.test(o.selectionId)
    || typeof o.candidatePath !== 'string' || o.candidatePath.length > 1024
    || !(o.expectedPath === null || typeof o.expectedPath === 'string' && o.expectedPath.length <= 2048
      && !/[?#:\\]/.test(o.expectedPath) && !o.expectedPath.startsWith('/')
      && !o.expectedPath.split('/').some((part) => part === '.' || part === '..'))
    || typeof o.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(o.sha256)
    || !Number.isSafeInteger(o.size) || o.size <= 0 || o.size > 5 * 1024 * 1024
    || !phases.includes(o.phase) || typeof o.uploadAttempted !== 'boolean' || typeof o.uploadConfirmed !== 'boolean') return false
  const parts = o.candidatePath.split('/')
  return parts.length === 4 && new RegExp(`^${storeId}-[a-z0-9]+(?:-[a-z0-9]+)*$`).test(parts[0])
    && parts[1] === 'products' && new RegExp(`^${productId}-[a-z0-9]+(?:-[a-z0-9]+)*$`).test(parts[2])
    && parts[3] === `principal-${o.selectionId}.webp`
}

export function createProductImageCoordinator(
  ownerId: string, storeId: number, storage: MetadataStorage, io: ImageOperationIO,
  changed: (operation: ProductImageOperation) => void = () => {},
) {
  if (!ownerId || !Number.isSafeInteger(storeId) || storeId <= 0) throw new Error('Tienda no valida.')
  let busy = false
  const key = (id: number) => `kafka.product-image.${ownerId}.${storeId}.${id}`
  function load(productId: number): ProductImageOperation | null {
    const raw = storage.getItem(key(productId))
    if (raw === null) return null
    if (raw.length > 8192) throw new Error('La operacion de imagen pendiente no es valida.')
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error('La operacion de imagen pendiente no es valida.') }
    if (!validImageOperation(parsed, ownerId, storeId, productId)) throw new Error('La operacion de imagen pendiente no es valida.')
    return parsed
  }
  function save(o: ProductImageOperation) {
    if (!validImageOperation(o, ownerId, storeId, o.productId)) throw new Error('Operacion de imagen no valida.')
    storage.setItem(key(o.productId), JSON.stringify(o))
    changed({ ...o })
  }
  return {
    load,
    begin(product: Product, storeSlug: string, prepared: PreparedProductImage, expectedPath: string | null) {
      if (busy || product.store_id !== storeId) throw new Error('No se puede iniciar esta imagen.')
      const old = load(product.id)
      if (old && old.phase !== 'linked') throw new Error('Hay una imagen pendiente. Reintenta o descarta ese cambio primero.')
      const operation: ProductImageOperation = {
        version: 1, ownerId, storeId, productId: product.id, selectionId: prepared.selectionId,
        candidatePath: `${storeId}-${slugifyPathSegment(storeSlug)}/products/${product.id}-${slugifyPathSegment(product.name)}/principal-${prepared.selectionId}.webp`,
        expectedPath, sha256: prepared.sha256, size: prepared.size, phase: 'prepared',
        uploadAttempted: false, uploadConfirmed: false,
      }
      save(operation)
      return operation
    },
    discard(productId: number) {
      if (busy) throw new Error('Hay una imagen en proceso.')
      storage.removeItem(key(productId)) // Metadata only; NEVER deletes a Storage object.
    },
    async run(productId: number, prepared?: PreparedProductImage): Promise<ImageOperationResult> {
      if (busy) throw new Error('Ya hay una imagen en proceso.')
      busy = true
      let operation: ProductImageOperation | null = null
      function transition(phase: ImagePhase) {
        operation!.phase = phase
        save(operation!) // Persist intent BEFORE each external write.
      }
      function result(status: ImageOperationResult['status'], message: string, product: Product | null = null): ImageOperationResult {
        transition(status)
        if (status === 'linked') {
          try { storage.removeItem(key(productId)) } catch { /* A linked receipt is safe to recover again. */ }
        }
        return { status, message, product }
      }
      async function read() {
        const p = await io.readProduct(productId)
        if (!p || p.store_id !== storeId || p.id !== productId) throw new Error('Producto no disponible.')
        return p
      }
      try {
        operation = load(productId)
        if (!operation) throw new Error('No hay una imagen pendiente.')
        let current = await read()
        if (current.image_path === operation.candidatePath) return result('linked', 'Imagen vinculada correctamente.', current)
        if (current.image_path !== operation.expectedPath || operation.phase === 'conflict') {
          return result('conflict', 'La imagen cambio en otra sesion. No se sobrescribio; recarga el producto antes de otro cambio.', current)
        }
        if (operation.uploadAttempted || operation.uploadConfirmed) {
          const verification = await io.verify(operation)
          if (verification === 'different') return result('conflict', 'El archivo candidato no coincide. No se sobrescribio ningun archivo.')
          if (verification === 'unknown') return result('uncertain', 'No se pudo verificar la subida. Conserva el cambio pendiente y reintenta.')
          if (verification === 'match') {
            operation.uploadConfirmed = true
            transition('uploaded')
          } else if (operation.uploadConfirmed) {
            return result('uncertain', 'La imagen confirmada no esta disponible. No se repetira su subida automaticamente.')
          } else {
            // Even a fresh 404 cannot prove a timed-out request has stopped writing.
            return result('uncertain', 'La subida anterior puede seguir en curso. Reintentar solo verificara el mismo archivo; no se enviara otra subida.')
          }
        }
        if (!operation.uploadConfirmed) {
          if (!prepared) return result('uncertain', 'Selecciona nuevamente el mismo archivo para completar la imagen pendiente.')
          if (prepared.sha256 !== operation.sha256 || prepared.size !== operation.size) {
            return result('conflict', 'El archivo seleccionado es distinto al cambio pendiente.')
          }
          operation.uploadAttempted = true
          transition('uploading')
          try {
            await io.upload(operation, prepared.blob)
            operation.uploadConfirmed = true
            transition('uploaded')
          } catch {
            // A lost response is NOT proof of failure. No second upload in this run.
            transition('uncertain')
            const verification = await io.verify(operation)
            if (verification === 'different') return result('conflict', 'El archivo candidato no coincide. No se sobrescribio.')
            if (verification !== 'match') return result('uncertain', 'La subida no pudo confirmarse. Reintenta la misma operacion.')
            operation.uploadConfirmed = true
            transition('uploaded')
          }
        }
        current = await read()
        if (current.image_path === operation.candidatePath) return result('linked', 'Imagen vinculada correctamente.', current)
        if (current.image_path !== operation.expectedPath) return result('conflict', 'Otra sesion cambio la imagen. No se sobrescribio.', current)
        transition('linking')
        const linked = await io.link(operation)
        if (linked.product && (linked.product.id !== productId || linked.product.store_id !== storeId)
          || linked.status === 'linked' && linked.product?.image_path !== operation.candidatePath) {
          return result('uncertain', 'No se pudo verificar el resultado de vinculacion.')
        }
        return result(linked.status, linked.status === 'linked' ? 'Imagen vinculada correctamente.'
          : linked.status === 'conflict' ? 'Otra sesion cambio la imagen. No se sobrescribio.'
          : 'No se pudo confirmar la vinculacion. Conserva la operacion y reintenta.', linked.product)
      } catch {
        if (operation) {
          try { transition('uncertain') } catch { /* Preserve the last durable intent if storage fails. */ }
        }
        return { status: 'uncertain', product: null, message: 'No se pudo completar la imagen. Conserva el cambio pendiente y reintenta.' }
      } finally { busy = false }
    },
  }
}
