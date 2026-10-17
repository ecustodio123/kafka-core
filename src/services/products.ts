import { getSupabaseClient } from '../lib/supabase'
import type {
  Product,
  ProductUpdate,
  Store,
} from '../types/database'
import { productCreationError, type ProductCreationInput, type ProductCreationResult } from './productCreation'

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
  const { data, error } = await getSupabaseClient()
    .rpc('create_product_idempotent', {
      p_store_id: storeId,
      p_operation_id: operationId,
      p_input: input,
    })
    .abortSignal(AbortSignal.timeout(15000))

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
  imagePath: Product['image_path'],
): Promise<Product> {
  return updateProductField(storeId, productId, { image_path: imagePath })
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
