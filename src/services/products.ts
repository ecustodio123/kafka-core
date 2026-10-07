import { getSupabaseClient } from '../lib/supabase'
import type {
  Product,
  ProductInsert,
  ProductUpdate,
  Store,
} from '../types/database'

const PRODUCT_COLUMNS =
  'id, store_id, name, description, price, image_path, available, active, created_at'

export type ProductFormInput = {
  name: string
  description: string
  price: number
  available: boolean
  active: boolean
}

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
  input: ProductFormInput,
): Promise<Product> {
  const payload: ProductInsert = {
    store_id: storeId,
    name: input.name,
    description: input.description || null,
    price: input.price,
    image_path: null,
    available: input.available,
    active: input.active,
  }

  const { data, error } = await getSupabaseClient()
    .from('products')
    .insert(payload)
    .select(PRODUCT_COLUMNS)
    .single()

  if (error) {
    throw new Error(error.message)
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
    available: input.available,
    active: input.active,
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

export async function setProductActive(
  storeId: Store['id'],
  productId: Product['id'],
  active: boolean,
): Promise<Product> {
  return updateProductField(storeId, productId, { active })
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
