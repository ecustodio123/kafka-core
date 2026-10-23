import type { ProductFormState } from './productForm.ts'

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>
export type ProductDraft = {
  version: 1; userId: string; storeId: number; productId: number | null
  revision: string; form: ProductFormState; baseline: ProductFormState | null; imagePending: boolean
}
const prefix = 'kafka.product-draft.'
export function clearProductDrafts(storage: DraftStorage, userId?: string) {
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i))
  for (const key of keys) if (key?.startsWith(userId ? `${prefix}${userId}.` : prefix)) storage.removeItem(key)
}
const fields = ['name', 'description', 'price', 'discount_price', 'visual_rating', 'category_id'] as const
function validForm(value: unknown): value is ProductFormState {
  if (!value || typeof value !== 'object') return false
  const form = value as ProductFormState
  return Object.keys(form).length === 8 && fields.every(field => typeof form[field] === 'string' && form[field].length <= 2000)
    && typeof form.discount_active === 'boolean' && typeof form.available === 'boolean'
}
export function sameDraftForm(a: ProductFormState, b: ProductFormState) {
  return [...fields, 'discount_active', 'available'].every(field => a[field as keyof ProductFormState] === b[field as keyof ProductFormState])
}
export function productDrafts(storage: DraftStorage, userId: string, storeId: number) {
  const scope = `${prefix}${userId}.${storeId}.`
  const key = (id: number | null) => `${scope}${id === null ? 'create' : `edit.${id}`}`
  const latest = `${scope}latest`
  function load(productId: number | null): ProductDraft | null {
    const raw = storage.getItem(key(productId))
    if (!raw || raw.length > 32768) return null
    try {
      const d = JSON.parse(raw) as ProductDraft
      return d.version === 1 && d.userId === userId && d.storeId === storeId && d.productId === productId
        && typeof d.revision === 'string' && validForm(d.form) && (d.baseline === null || validForm(d.baseline))
        && typeof d.imagePending === 'boolean' ? d : null
    } catch { return null }
  }
  return {
    load,
    latest() {
      const id = storage.getItem(latest)
      if (id === 'create') return load(null)
      return id && /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id)) ? load(Number(id)) : null
    },
    save(draft: Omit<ProductDraft, 'version' | 'userId' | 'storeId' | 'revision'>, expected: ProductDraft | null): ProductDraft {
      const current = load(draft.productId)
      if ((current && current.revision !== expected?.revision) || (!current && expected)) {
        throw new Error('El borrador cambio o fue descartado. Reabre el formulario para recuperarlo.')
      }
      const next: ProductDraft = { ...draft, version: 1, userId, storeId, revision: crypto.randomUUID() }
      storage.setItem(key(draft.productId), JSON.stringify(next))
      storage.setItem(latest, draft.productId === null ? 'create' : String(draft.productId))
      return next
    },
    clear(draft: ProductDraft) {
      if (load(draft.productId)?.revision !== draft.revision) return
      storage.removeItem(key(draft.productId))
      if (storage.getItem(latest) === (draft.productId === null ? 'create' : String(draft.productId))) storage.removeItem(latest)
    },
    clearUser() {
      clearProductDrafts(storage, userId)
    },
  }
}
