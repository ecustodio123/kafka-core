import { AuthClient } from '@supabase/supabase-js'
import type { Session, SupabaseClient, User, UserResponse } from '@supabase/supabase-js'
import type { Database } from '../../types/database'

export const invitePath = '/auth/accept-invite'
export class InviteFlowError extends Error {}
const markerKey = 'kafka-admin:pending-invite'
const sensitiveKeys = ['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'token', 'token_hash', 'code', 'error', 'error_code', 'error_description', 'expires_at', 'expires_in', 'token_type', 'type', 'flow_id']

export function readAuthReturn(href: string) {
  const url = new URL(href)
  const hash = new URLSearchParams(url.hash.slice(1))
  const value = (key: string) => hash.get(key) ?? url.searchParams.get(key)
  const type = value('type')
  return {
    invite: type === 'invite',
    route: url.pathname === invitePath,
    error: !!(value('error') || value('error_code') || value('error_description')),
    // Kept in memory only, until the SDK finishes its own callback handling.
    accessToken: type === 'invite' ? value('access_token') : null,
    unsupported: !!value('code') || !!value('token_hash'),
    wrongType: !!type && type !== 'invite',
  }
}

export function cleanAuthReturn(href: string, path?: string) {
  const url = new URL(href)
  for (const key of sensitiveKeys) url.searchParams.delete(key)
  const hash = new URLSearchParams(url.hash.slice(1))
  if (sensitiveKeys.some(key => hash.has(key))) url.hash = ''
  if (path) url.pathname = path
  return `${url.pathname}${url.search}${url.hash}`
}

function claims(token: string): { sub?: string; session_id?: string; exp?: number; amr?: { method: string }[] } {
  try {
    const encoded = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')
    const value = JSON.parse(atob(encoded))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

export function isInviteSession(session: Session, verifiedUser: User) {
  const data = claims(session.access_token)
  // Implicit invite verification uses OTP, not a dedicated INVITED event/claim.
  return verifiedUser.id === session.user.id && data.sub === verifiedUser.id &&
    !!verifiedUser.invited_at && !!verifiedUser.email_confirmed_at &&
    typeof data.session_id === 'string' && data.session_id.length > 0 && Array.isArray(data.amr) &&
    data.amr.some(entry => entry && (entry.method === 'otp' || entry.method === 'invite'))
}

export function passwordError(password: string, confirmation: string): string | null {
  if (!password.trim() || password.length < 8) return 'Usa una contrasena de al menos 8 caracteres.'
  if (password.length > 128) return 'La contrasena no puede superar 128 caracteres.'
  if (password !== confirmation) return 'Las contrasenas no coinciden.'
  return null
}

function unexpired(token: string) {
  const expiry = claims(token).exp
  return typeof expiry === 'number' && Number.isFinite(expiry) && expiry * 1000 > Date.now()
}

type PasswordWriter = (session: Session, password: string, assertCurrent: () => Promise<void>) => Promise<UserResponse>

export function createInvitePasswordWriter(url: string, publicKey: string, fetcher: typeof fetch = fetch): PasswordWriter {
  const endpoint = `${url.replace(/\/$/, '')}/auth/v1/user`
  return async (session, password, assertCurrent) => {
    const accessToken = session.access_token
    const auth = new AuthClient({
      url: endpoint.slice(0, -'/user'.length),
      headers: { apikey: publicKey },
      storageKey: `kafka-invite-${crypto.randomUUID()}`,
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      // No shared storage/BroadcastChannel, refresh, or fallback bearer is allowed.
      fetch: async (input, init) => {
        const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (target !== endpoint || !['GET', 'PUT'].includes(init?.method ?? 'GET') ||
          new Headers(init?.headers).get('authorization') !== `Bearer ${accessToken}` || !unexpired(accessToken)) {
          // A non-retryable local response also prevents the SDK retrying refresh.
          return new Response(JSON.stringify({ code: 'session_expired', message: 'Invitation session unavailable' }), { status: 400 })
        }
        if (init?.method === 'PUT') {
          await assertCurrent()
          if (!unexpired(accessToken)) throw new InviteFlowError('La sesion de invitacion ha expirado.')
        }
        return fetcher(input, init)
      },
    })
    try {
      if (!unexpired(accessToken)) throw new InviteFlowError('La sesion de invitacion ha expirado.')
      const { data, error } = await auth.setSession({ access_token: accessToken, refresh_token: session.refresh_token })
      if (error || !data.session || !data.user || !isInviteSession(data.session, data.user) || data.user.id !== session.user.id) {
        throw new InviteFlowError('La sesion de invitacion ya no es valida. Abre nuevamente tu invitacion.')
      }
      return await auth.updateUser({ password })
    } finally { await auth.dispose() }
  }
}

type AuthReturn = ReturnType<typeof readAuthReturn>
export function createInviteFlow(callback: AuthReturn, storage: Storage | null, replace: (path: string) => void, writePassword: PasswordWriter) {
  let expectedToken = callback.accessToken
  callback.accessToken = null
  let pending: { userId: string; sessionId: string } | null = null
  try {
    const raw = storage?.getItem(markerKey)
    const value = raw ? JSON.parse(raw) : null
    if (typeof value?.userId === 'string' && typeof value?.sessionId === 'string') pending = value
  } catch { /* A route-bound invitation remains recoverable without browser storage. */ }
  let active = callback.invite || callback.route || callback.error || callback.unsupported || !!pending
  let initial: Promise<Session> | null = null
  let saving = false
  const failure = () => new InviteFlowError('La invitacion no es valida o ha expirado. Solicita un nuevo enlace a Kafka.')

  function remember(session: Session) {
    pending = { userId: session.user.id, sessionId: claims(session.access_token).session_id! }
    try { storage?.setItem(markerKey, JSON.stringify(pending)) } catch { /* No secrets are persisted here. */ }
  }
  function clear() {
    pending = null
    try { storage?.removeItem(markerKey) } catch { /* Session storage can be disabled. */ }
  }
  async function verify(client: SupabaseClient<Database>, expectedUserId?: string) {
    const { data, error } = await client.auth.getSession()
    // Copy before awaiting Auth: callers can mutate/replace the SDK session meanwhile.
    const session = data.session ? { ...data.session, user: { ...data.session.user } } : null
    if (error || !session || (expectedUserId && session.user.id !== expectedUserId)) throw failure()
    if (!unexpired(session.access_token)) throw failure()
    if (expectedToken && session.access_token !== expectedToken) throw failure()
    // Explicit token avoids trusting the user cached in localStorage.
    const { data: verified, error: userError } = await client.auth.getUser(session.access_token)
    if (userError || !verified.user || !isInviteSession(session, verified.user)) throw failure()
    const sessionId = claims(session.access_token).session_id
    if (pending && (pending.userId !== verified.user.id || pending.sessionId !== sessionId)) throw failure()
    return session
  }
  return {
    get active() { return active },
    async initialize(client: SupabaseClient<Database>) {
      // One SDK callback/verification, including React StrictMode remounts.
      initial ??= (async () => {
        try {
          if (callback.error || callback.unsupported || callback.wrongType || (callback.invite && !expectedToken)) throw failure()
          const session = await verify(client)
          remember(session)
          replace(invitePath)
          return session
        } finally { expectedToken = null; replace(invitePath) }
      })()
      return initial
    },
    async updatePassword(client: SupabaseClient<Database>, userId: string, password: string) {
      if (saving || !active || !pending || pending.userId !== userId) throw failure()
      saving = true
      try {
        const session = await verify(client, userId)
        const assertCurrent = async () => {
          const { data: current, error: currentError } = await client.auth.getSession()
          if (!active || !pending || currentError || !current.session || current.session.user.id !== userId ||
            claims(current.session.access_token).session_id !== pending.sessionId ||
            current.session.access_token !== session.access_token || !unexpired(session.access_token)) throw failure()
        }
        await assertCurrent()
        const { data, error } = await writePassword(session, password, assertCurrent)
        if (error || data.user?.id !== userId) {
          if (error?.code === 'weak_password') throw new InviteFlowError('Supabase requiere una contrasena mas segura. Revisa la politica del proyecto.')
          if (error?.code === 'same_password') throw new InviteFlowError('Elige una contrasena diferente de la actual.')
          throw new InviteFlowError('No se confirmo el cambio de contrasena. Revisa tu conexion o solicita un nuevo enlace.')
        }
        clear()
        replace('/')
      } finally { saving = false }
    },
    finish() { active = false; clear(); replace('/') },
  }
}
