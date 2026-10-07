import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const hasSupabaseConfig = Boolean(supabaseUrl && supabasePublishableKey)

export const supabase: SupabaseClient<Database> | null = hasSupabaseConfig
  ? createClient<Database>(supabaseUrl, supabasePublishableKey)
  : null

export function getSupabaseClient() {
  if (!supabase) {
    throw new Error(
      'Configura VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY en un archivo .env local.',
    )
  }

  return supabase
}
