import { getSupabaseClient } from '../lib/supabase'
import type { Store } from '../types/database'

const STORE_COLUMNS = 'id, name, slug, owner_user_id, created_at'

export async function getCurrentUserStore(userId: string): Promise<Store | null> {
  const { data, error } = await getSupabaseClient()
    .from('stores')
    .select(STORE_COLUMNS)
    .eq('owner_user_id', userId)
    .maybeSingle()

  if (error) {
    throw new Error(error.message)
  }

  return data
}
