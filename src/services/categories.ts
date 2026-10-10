import { getSupabaseClient } from '../lib/supabase'
import type {
  Category,
  CategoryInsert,
  CategoryUpdate,
  Product,
  Store,
} from '../types/database'

const CATEGORY_COLUMNS =
  'id, store_id, name, slug, image_url, sort_order, active, created_at'

export type CategoryFormInput = {
  name: string
  slug: string
  sort_order: number
  active: boolean
}

export type CategoryProductCounts = Record<Category['id'], number>

export async function listCategories(
  storeId: Store['id'],
): Promise<Category[]> {
  const { data, error } = await getSupabaseClient()
    .from('categories')
    .select(CATEGORY_COLUMNS)
    .eq('store_id', storeId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })

  if (error) {
    throw new Error(error.message)
  }

  return data ?? []
}

export async function createCategory(
  storeId: Store['id'],
  input: CategoryFormInput,
): Promise<Category> {
  const payload: CategoryInsert = {
    store_id: storeId,
    name: input.name,
    slug: input.slug,
    sort_order: input.sort_order,
    active: input.active,
  }

  const { data, error } = await getSupabaseClient()
    .from('categories')
    .insert(payload)
    .select(CATEGORY_COLUMNS)
    .single()

  if (error) {
    throw new Error(formatCategoryError(error.message))
  }

  return data
}

export async function updateCategory(
  storeId: Store['id'],
  categoryId: Category['id'],
  input: CategoryFormInput,
): Promise<Category> {
  const payload: CategoryUpdate = {
    name: input.name,
    slug: input.slug,
    sort_order: input.sort_order,
    active: input.active,
  }

  const { data, error } = await getSupabaseClient()
    .from('categories')
    .update(payload)
    .eq('id', categoryId)
    .eq('store_id', storeId)
    .select(CATEGORY_COLUMNS)
    .single()

  if (error) {
    throw new Error(formatCategoryError(error.message))
  }

  return data
}

export async function setCategoryActive(
  storeId: Store['id'],
  categoryId: Category['id'],
  active: boolean,
): Promise<Category> {
  return updateCategoryField(storeId, categoryId, { active })
}

export async function setCategoryImageUrl(
  storeId: Store['id'],
  categoryId: Category['id'],
  imageUrl: Category['image_url'],
): Promise<Category> {
  return updateCategoryField(storeId, categoryId, { image_url: imageUrl })
}

export async function updateCategoryOrder(
  storeId: Store['id'],
  categoryId: Category['id'],
  sortOrder: number,
): Promise<Category> {
  return updateCategoryField(storeId, categoryId, { sort_order: sortOrder })
}

export async function getCategoryProductCounts(
  storeId: Store['id'],
): Promise<CategoryProductCounts> {
  const { data, error } = await getSupabaseClient()
    .from('products')
    .select('category_id')
    .eq('store_id', storeId)
    .not('category_id', 'is', null)

  if (error) {
    throw new Error(error.message)
  }

  return (data ?? []).reduce<CategoryProductCounts>((counts, product) => {
    const categoryId = (product as Pick<Product, 'category_id'>).category_id
    if (categoryId) {
      counts[categoryId] = (counts[categoryId] ?? 0) + 1
    }

    return counts
  }, {})
}

async function updateCategoryField(
  storeId: Store['id'],
  categoryId: Category['id'],
  payload: CategoryUpdate,
): Promise<Category> {
  const { data, error } = await getSupabaseClient()
    .from('categories')
    .update(payload)
    .eq('id', categoryId)
    .eq('store_id', storeId)
    .select(CATEGORY_COLUMNS)
    .single()

  if (error) {
    throw new Error(formatCategoryError(error.message))
  }

  return data
}

function formatCategoryError(message: string) {
  if (
    message.includes('categories_store_slug_unique') ||
    message.toLowerCase().includes('duplicate key')
  ) {
    return 'Ya existe una categoria con ese slug en esta tienda.'
  }

  return message
}
