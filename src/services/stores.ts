import { getSupabaseClient } from '../lib/supabase'
import type { Store } from '../types/database'

const STORE_COLUMNS = 'id, name, slug, owner_user_id, created_at'

export async function getUserStores(userId: string, superAdmin: boolean): Promise<Store[]> {
  let query = getSupabaseClient()
    .from('stores')
    .select(STORE_COLUMNS)
    .order('name').order('id')
  if (!superAdmin) query = query.eq('owner_user_id', userId)
  const { data, error } = await query

  if (error) {
    throw new Error(error.message)
  }

  return data ?? []
}
