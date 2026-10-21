import { createClient } from 'npm:@supabase/supabase-js@2'

type Result = { data: unknown; error: { code?: string } | null }
type Client = {
  auth: { getUser: (token: string) => Promise<{ data: { user: { id: string } | null }; error: unknown }> }
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<Result>
  storage: { from: (bucket: string) => { remove: (paths: string[]) => Promise<{ error: unknown }> } }
}
type Config = { enabled: boolean; cleanup: boolean; origins: string[]; storageOrigin: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

async function readBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('payload')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('payload')
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 8192) { await reader.cancel(); throw new Error('payload') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder().decode(bytes))
}

export function createHandler(config: Config, client: Client) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin')
    const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'Origin' })
    if (origin && config.origins.includes(origin)) headers.set('access-control-allow-origin', origin)
    headers.set('access-control-allow-headers', 'authorization,apikey,content-type,x-client-info')
    headers.set('access-control-allow-methods', 'POST,OPTIONS')
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers })
    if (origin && !config.origins.includes(origin)) return reply(403, { error: 'Origen no autorizado.' })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return reply(405, { error: 'Metodo no permitido.' })
    if (!config.enabled) return reply(503, { error: 'Eliminacion backend deshabilitada o pendiente de despliegue.' })
    const bearer = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1]
    if (!bearer) return reply(401, { error: 'Inicia sesion nuevamente.' })
    try {
      const { data: auth, error: authError } = await client.auth.getUser(bearer)
      if (authError || !auth.user) return reply(401, { error: 'Inicia sesion nuevamente.' })
      let body: unknown
      try { body = await readBody(request) } catch { return reply(400, { error: 'Solicitud no valida.' }) }
      if (!object(body) || Object.keys(body).some(k => !['action', 'store_id', 'kind', 'entity_id', 'operation_id'].includes(k)) ||
        !Number.isSafeInteger(body.store_id) || (body.store_id as number) <= 0 ||
        !['product', 'category'].includes(String(body.kind)) || typeof body.entity_id !== 'string' ||
        !(body.kind === 'product' ? /^[1-9][0-9]{0,18}$/.test(body.entity_id) && Number.isSafeInteger(Number(body.entity_id)) : uuid.test(body.entity_id)) ||
        !['delete', 'cleanup'].includes(String(body.action)) ||
        (body.action === 'delete' && (typeof body.operation_id !== 'string' || !uuid.test(body.operation_id)))) {
        return reply(400, { error: 'Solicitud no valida.' })
      }
      const args = { p_actor: auth.user.id, p_store: body.store_id, p_kind: body.kind, p_id: body.entity_id }
      let receipt: Record<string, unknown> = {}
      if (body.action === 'delete') {
        const result = await client.rpc('delete_catalog_entity', { ...args, p_operation: body.operation_id })
        if (result.error) {
          const code = result.error.code
          return reply(code === '42501' ? 403 : code === 'P0002' ? 404 : ['23503', '23505'].includes(code ?? '') ? 409 : 503,
            { error: code === '23503' ? 'La categoria tiene productos o existen referencias que impiden eliminar.' :
              'No se confirmo la eliminacion. Reintenta con la misma operacion; revisa permisos y referencias.' })
        }
        if (!object(result.data) || result.data.deleted !== true) return reply(503, { error: 'Eliminacion no confirmada.' })
        receipt = result.data
      }
      const states: string[] = []
      if (body.action === 'cleanup' && !config.cleanup) return reply(503, { error: 'Limpieza backend deshabilitada.' })
      if (config.cleanup) {
        const listed = await client.rpc('catalog_image_cleanup_jobs', args)
        if (listed.error?.code === '42501') return reply(403, { error: 'Acceso no autorizado.' })
        if (Array.isArray(listed.data) && listed.data.length > 5) states.push('pending')
        if (listed.error || !Array.isArray(listed.data)) states.push('pending')
        else for (const id of listed.data.slice(0, 5)) {
          if (typeof id !== 'string' || !uuid.test(id)) { states.push('pending'); continue }
          const claimed = await client.rpc('claim_catalog_image_cleanup', { p_actor: auth.user.id, p_store: body.store_id, p_job: id, p_origin: config.storageOrigin })
          if (claimed.error || !object(claimed.data)) { states.push('pending'); continue }
          const claim = claimed.data
          if (claim.acquired !== true) { states.push(String(claim.state ?? 'pending')); continue }
          // Never accept a bucket/path from the browser. All targets come from a private SQL claim.
          if (!['product-images', 'category-images'].includes(String(claim.bucket)) || typeof claim.path !== 'string' ||
            typeof claim.claim_token !== 'string' || !uuid.test(claim.claim_token)) { states.push('pending'); continue }
          let success = false
          try { success = !(await client.storage.from(String(claim.bucket)).remove([claim.path])).error } catch { /* Retry same retired path, never recreate it. */ }
          const finished = await client.rpc('finish_catalog_image_cleanup', { p_actor: auth.user.id, p_store: body.store_id,
            p_job: id, p_claim: claim.claim_token, p_success: success })
          states.push(!finished.error && finished.data === true && success ? 'deleted' : 'pending')
        }
      } else {
        const listed = await client.rpc('catalog_image_cleanup_jobs', args)
        if (listed.error || !Array.isArray(listed.data) || listed.data.length > 0) states.push('pending')
      }
      return reply(200, { deleted: body.action === 'delete', replayed: receipt.replayed === true,
        cleanup: states.some(s => s !== 'deleted') ? states.includes('retained_shared') ? 'retained_shared' : 'pending' :
          receipt.cleanup === 'retained_unverified' ? 'retained_unverified' : 'complete' })
    } catch { return reply(503, { error: 'Resultado no confirmado. Reintenta con la misma operacion.' }) }
  }
}

if (import.meta.main) {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  Deno.serve(createHandler({ enabled: Deno.env.get('CATALOG_DELETE_ENABLED') === 'true',
    cleanup: Deno.env.get('CATALOG_MEDIA_CLEANUP_ENABLED') === 'true',
    storageOrigin: new URL(url).origin,
    origins: (Deno.env.get('CATALOG_DELETE_ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean),
  }, createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init,
      signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(15000)]),
    }) },
  })))
}
