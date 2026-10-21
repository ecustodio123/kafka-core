import { getSupabaseClient } from '../lib/supabase'
import type { ModuleFlags, StoreFeatures } from '../types/database'

const columns = 'store_id, commerce_enabled, services_enabled, staff_enabled'
export const moduleKeys = ['commerce_enabled', 'services_enabled', 'staff_enabled'] as const

export async function getStoreFeatures(storeId: number): Promise<StoreFeatures | null> {
  const { data, error } = await getSupabaseClient().from('store_features').select(columns).eq('store_id', storeId).maybeSingle()
  if (error) throw error
  return data
}

export async function saveStoreFeatures(storeId: number, expected: StoreFeatures | null, flags: ModuleFlags): Promise<StoreFeatures> {
  const client = getSupabaseClient()
  if (expected) {
    let query = client.from('store_features').update(flags).eq('store_id', storeId)
    for (const key of moduleKeys) query = expected[key] === null ? query.is(key, null) : query.eq(key, expected[key])
    const { data, error } = await query.select(columns).maybeSingle()
    if (error) throw error
    if (data) return data
  } else {
    const { data, error } = await client.from('store_features').insert({ store_id: storeId, ...flags }).select(columns).single()
    if (!error) return data
    if (error.code !== '23505') throw error
  }
  const current = await getStoreFeatures(storeId)
  if (current && moduleKeys.every(key => current[key] === flags[key])) return current
  throw new Error('La configuracion cambio en otra sesion. Recarga antes de guardar.')
}
