import { getSupabaseClient } from '../lib/supabase'
import type {
  Product,
  ProductInsert,
  ProductUpdate,
  Store,
} from '../types/database'

const PRODUCT_COLUMNS =
  'id, store_id, name, description, price, discount_active, discount_price, visual_rating, image_path, category_id, available, active, created_at'

export type ProductFormInput = {
  name: string
  description: string
  price: number
  discount_active: boolean
  discount_price: number | null
  visual_rating: number | null
  category_id: string | null
  available: boolean
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
    discount_active: input.discount_active,
    discount_price: input.discount_price,
    visual_rating: input.visual_rating,
    image_path: null,
    category_id: input.category_id,
    available: input.available,
    active: true,
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
