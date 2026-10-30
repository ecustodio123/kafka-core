import { withProductDeadline } from './productCompatibility.ts'
import { getSupabaseClient } from '../lib/supabase'
import type {
  Product,
  ProductUpdate,
  Store,
} from '../types/database'
import { productCreationError, type ProductCreationInput, type ProductCreationResult } from './productCreation'
import type { ImageLinkResult } from './productImageOperation'

const PRODUCT_COLUMNS =
  'id, store_id, name, description, price, discount_active, discount_price, visual_rating, image_path, category_id, available, active, created_at'

export type ProductFormInput = ProductCreationInput

export async function getProducts(storeId: Store['id']): Promise<Product[]> {
  const { data, error } = await getSupabaseClient()
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('store_id', storeId)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(error.message)
  }

  return data ?? []
}

export async function createProduct(
  storeId: Store['id'],
  operationId: string,
  input: ProductFormInput | null,
): Promise<ProductCreationResult> {
  const { data, error } = await withProductDeadline(signal => getSupabaseClient()
    .rpc('create_product_idempotent', {
      p_store_id: storeId,
      p_operation_id: operationId,
      p_input: input,
    })
    .abortSignal(signal))

  if (error) {
    throw productCreationError(error)
  }

  if (!data || !['found', 'not_found', 'deleted'].includes(data.status)) {
    throw new Error('Respuesta de creacion no valida. No se repetira un INSERT tradicional.')
  }
  return data
}

export async function updateProduct(
  storeId: Store['id'],
  productId: Product['id'],
  input: ProductFormInput,
): Promise<Product> {
  const payload: ProductUpdate = {
    name: input.name,
    description: input.description || null,
    price: input.price,
    discount_active: input.discount_active,
    discount_price: input.discount_price,
    visual_rating: input.visual_rating,
    category_id: input.category_id,
    available: input.available,
  }

  const { data, error } = await getSupabaseClient()
    .from('products')
    .update(payload)
    .eq('id', productId)
    .eq('store_id', storeId)
    .select(PRODUCT_COLUMNS)
    .single()

  if (error) {
    throw new Error(error.message)
  }

  return data
}

export async function setProductAvailability(
  storeId: Store['id'],
  productId: Product['id'],
  available: boolean,
): Promise<Product> {
  return updateProductField(storeId, productId, { available })
}

export async function setProductImagePath(
  storeId: Store['id'],
  productId: Product['id'],
  imagePath: string,
  expectedPath: Product['image_path'],
): Promise<ImageLinkResult> {
  try {
    let request = getSupabaseClient().from('products')
      .update({ image_path: imagePath }).eq('id', productId).eq('store_id', storeId)
    request = expectedPath === null ? request.is('image_path', null) : request.eq('image_path', expectedPath)
    const { data, error } = await withProductDeadline(signal => request.select(PRODUCT_COLUMNS)
      .abortSignal(signal).maybeSingle())
    if (!error && data) return { status: 'linked', product: data }
  } catch { /* An aborted response does not prove rollback. Read before retrying. */ }
  try {
    const current = await getProduct(storeId, productId)
    if (current?.image_path === imagePath) return { status: 'linked', product: current }
    if (current && current.image_path !== expectedPath) return { status: 'conflict', product: current }
    return { status: 'uncertain', product: current }
  } catch { return { status: 'uncertain', product: null } }
}

export async function getProduct(storeId: number, productId: number): Promise<Product | null> {
  const { data, error } = await withProductDeadline(signal => getSupabaseClient().from('products').select(PRODUCT_COLUMNS)
    .eq('id', productId).eq('store_id', storeId).abortSignal(signal).maybeSingle())
  if (error) throw new Error('No se pudo consultar el producto.')
  return data
}

async function updateProductField(
  storeId: Store['id'],
  productId: Product['id'],
  payload: ProductUpdate,
): Promise<Product> {
  const { data, error } = await getSupabaseClient()
    .from('products')
    .update(payload)
    .eq('id', productId)
    .eq('store_id', storeId)
    .select(PRODUCT_COLUMNS)
    .single()

  if (error) {
    throw new Error(error.message)
  }

  return data
}
