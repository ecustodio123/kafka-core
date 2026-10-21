import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { cleanAuthReturn, createInviteFlow, createInvitePasswordWriter, readAuthReturn } from '../features/auth/inviteFlow'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

// Capture before createClient starts processing and removes the implicit callback.
const callback = readAuthReturn(window.location.href)
let inviteStorage: Storage | null = null
try { inviteStorage = window.localStorage } catch { /* Browser storage may be disabled. */ }
export const inviteFlow = createInviteFlow(callback, inviteStorage, path => {
  window.history.replaceState(null, '', cleanAuthReturn(window.location.href, path))
}, createInvitePasswordWriter(supabaseUrl ?? '', supabasePublishableKey ?? ''))

export const hasSupabaseConfig = Boolean(supabaseUrl && supabasePublishableKey)

export const supabase: SupabaseClient<Database> | null = hasSupabaseConfig
  ? createClient<Database>(supabaseUrl, supabasePublishableKey, {
      auth: {
        flowType: 'implicit',
        detectSessionInUrl: (url, params) => {
          const isCallback = Boolean(params.access_token || params.error || params.error_code || params.error_description)
          if (isCallback) {
            // The SDK already captured params. Replace, rather than push, the sensitive URL.
            window.history.replaceState(null, '', cleanAuthReturn(url.href, inviteFlow.active ? '/auth/accept-invite' : undefined))
          }
          return isCallback
        },
      },
    })
  : null

export function getSupabaseClient() {
  if (!supabase) {
    throw new Error(
      'Configura VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY en un archivo .env local.',
    )
  }

  return supabase
}
