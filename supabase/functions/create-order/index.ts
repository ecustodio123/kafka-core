import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3'

type OrderItemInput = {
  product_id: unknown
  quantity: unknown
}

type CreateOrderPayload = {
  store_id?: unknown
  items?: unknown
  customer?: unknown
  idempotency_key?: unknown
  whatsapp_message?: unknown
  checkout_mode?: unknown
}

type CustomerInput = {
  name?: unknown
  phone?: unknown
  email?: unknown
}

type ValidatedPayload = {
  storeId: number
  items: Array<{ product_id: number; quantity: number }>
  customerName: string
  customerPhone: string
  customerEmail: string | null
  idempotencyKey: string
  whatsappMessage: string | null
  checkoutMode: CheckoutMode
}

type CheckoutMode = 'online' | 'whatsapp'

type SupabaseResult<T> = {
  data: T | null
  error: { message: string } | null
}

type SupabaseLike = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<SupabaseResult<unknown>>
}

type HandlerDependencies = {
  createSupabaseClient: () => SupabaseLike | null
  env: (name: string) => string | undefined
  now: () => Date
}

const MAX_BODY_BYTES = 16 * 1024
const MAX_ITEMS = 50
const MAX_QUANTITY_PER_ITEM = 99
const MAX_IDEMPOTENCY_LENGTH = 120
const MAX_NAME_LENGTH = 120
const MAX_PHONE_LENGTH = 32
const MAX_EMAIL_LENGTH = 180
const MAX_WHATSAPP_MESSAGE_LENGTH = 4000
const PAYMENT_SESSION_TTL_MS = 15 * 60 * 1000
const EMAIL_PATTERN = new RegExp(
  "^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$",
)

export function createHandler(dependencies: HandlerDependencies) {
  return async (request: Request) => {
    const origin = request.headers.get('origin')
    const allowedOrigins = parseAllowedOrigins(
      dependencies.env('CREATE_ORDER_ALLOWED_ORIGINS') ?? '',
    )
    const corsHeaders = getCorsHeaders(origin, allowedOrigins)

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders ?? undefined,
        status: corsHeaders ? 204 : 403,
      })
    }

    if (!corsHeaders) {
      return jsonResponse({ error: 'Origin no permitido.' }, 403)
    }

    if (request.method !== 'POST') {
      return jsonResponse(
        { error: 'Metodo no permitido.' },
        405,
        corsHeaders,
        { Allow: 'POST, OPTIONS' },
      )
    }

    const contentType = request.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('application/json')) {
      return jsonResponse(
        { error: 'El contenido debe ser application/json.' },
        415,
        corsHeaders,
      )
    }

    try {
      const rawBody = await readLimitedBody(request, MAX_BODY_BYTES)
      const payload = validatePayload(JSON.parse(rawBody) as CreateOrderPayload)

      const supabase = dependencies.createSupabaseClient()
      if (!supabase) {
        return jsonResponse(
          { error: 'Configuracion de servidor incompleta.' },
          500,
          corsHeaders,
        )
      }

      const orderResult = payload.checkoutMode === 'online'
        ? await createOnlineOrder(supabase, payload, dependencies.now)
        : await createWhatsappOrder(supabase, payload)

      if (orderResult.error) {
        return jsonResponse(
          { error: getSafeDatabaseError(orderResult.error.message) },
          getStatusForDatabaseError(orderResult.error.message),
          corsHeaders,
        )
      }

      return jsonResponse(orderResult.body, 201, corsHeaders)
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Solicitud invalida.' },
        400,
        corsHeaders,
      )
    }
  }
}

const defaultDependencies: HandlerDependencies = {
  createSupabaseClient: () => {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !serviceRoleKey) {
      return null
    }

    return createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: {
          'X-Client-Info': 'kafka-payments-create-order',
        },
      },
    }) as unknown as SupabaseLike
  },
  env: (name: string) => Deno.env.get(name) ?? undefined,
  now: () => new Date(),
}

export const handler = createHandler(defaultDependencies)

if (import.meta.main) {
  serve(handler)
}

function validatePayload(payload: CreateOrderPayload): ValidatedPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload invalido.')
  }

  const storeId = parsePositiveInteger(payload.store_id, 'store_id')
  const idempotencyKey = parseRequiredString(
    payload.idempotency_key,
    'idempotency_key',
    MAX_IDEMPOTENCY_LENGTH,
  )

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error('Agrega al menos un producto.')
  }

  if (payload.items.length > MAX_ITEMS) {
    throw new Error(`No se permiten mas de ${MAX_ITEMS} productos por orden.`)
  }

  const items = normalizeItems(payload.items as OrderItemInput[])
  const customer = validateCustomer(payload.customer)
  const whatsappMessage = parseOptionalString(
    payload.whatsapp_message,
    'whatsapp_message',
    MAX_WHATSAPP_MESSAGE_LENGTH,
  )
  const checkoutMode = parseCheckoutMode(payload.checkout_mode)

  return {
    storeId,
    items,
    customerName: customer.name,
    customerPhone: customer.phone,
    customerEmail: customer.email,
    idempotencyKey,
    whatsappMessage,
    checkoutMode,
  }
}

async function createOnlineOrder(
  supabase: SupabaseLike,
  payload: ValidatedPayload,
  now: () => Date,
) {
  const paymentSessionToken = createPaymentSessionToken()
  const paymentSessionTokenHash = await sha256Hex(paymentSessionToken)
  const expiresAt = new Date(now().getTime() + PAYMENT_SESSION_TTL_MS)

  const { data, error } = await supabase.rpc(
    'create_kafka_online_order_with_payment_session',
    {
      p_store_id: payload.storeId,
      p_customer_name: payload.customerName,
      p_customer_phone: payload.customerPhone,
      p_customer_email: payload.customerEmail,
      p_idempotency_key: payload.idempotencyKey,
      p_whatsapp_message: payload.whatsappMessage,
      p_items: payload.items,
      p_payment_session_token_hash: paymentSessionTokenHash,
      p_payment_session_expires_at: expiresAt.toISOString(),
    },
  )

  if (error) {
    return { body: {}, error }
  }

  const result = data as {
    order: unknown
    payment_session_created?: boolean
    payment_session?: { expires_at?: string }
  }
  const body: Record<string, unknown> = { order: result.order }

  if (result.payment_session_created === true) {
    body.payment_session = {
      token: paymentSessionToken,
      expires_at: result.payment_session?.expires_at ?? expiresAt.toISOString(),
    }
  }

  return { body, error: null }
}

async function createWhatsappOrder(supabase: SupabaseLike, payload: ValidatedPayload) {
  const { data, error } = await supabase.rpc('create_kafka_order', {
    p_store_id: payload.storeId,
    p_customer_name: payload.customerName,
    p_customer_phone: payload.customerPhone,
    p_customer_email: payload.customerEmail,
    p_idempotency_key: payload.idempotencyKey,
    p_whatsapp_message: payload.whatsappMessage,
    p_items: payload.items,
  })

  if (error) {
    return { body: {}, error }
  }

  return { body: { order: data }, error: null }
}

function normalizeItems(items: OrderItemInput[]) {
  const mergedItems = new Map<number, number>()

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      throw new Error('Cada producto debe ser un objeto valido.')
    }

    const productId = parsePositiveInteger(item.product_id, 'product_id')
    const quantity = parsePositiveInteger(item.quantity, 'quantity')

    if (quantity > MAX_QUANTITY_PER_ITEM) {
      throw new Error(`La cantidad maxima por producto es ${MAX_QUANTITY_PER_ITEM}.`)
    }

    mergedItems.set(productId, (mergedItems.get(productId) ?? 0) + quantity)
  }

  return Array.from(mergedItems, ([product_id, quantity]) => {
    if (quantity > MAX_QUANTITY_PER_ITEM) {
      throw new Error(`La cantidad maxima por producto es ${MAX_QUANTITY_PER_ITEM}.`)
    }

    return { product_id, quantity }
  })
}

function validateCustomer(value: unknown) {
  if (!value || typeof value !== 'object') {
    throw new Error('Ingresa los datos del comprador.')
  }

  const customer = value as CustomerInput
  const name = parseRequiredString(customer.name, 'customer.name', MAX_NAME_LENGTH)
  const phone = parseRequiredString(customer.phone, 'customer.phone', MAX_PHONE_LENGTH)
  const email = parseOptionalString(customer.email, 'customer.email', MAX_EMAIL_LENGTH)

  if (email && !EMAIL_PATTERN.test(email)) {
    throw new Error('El email del comprador no es valido.')
  }

  return { name, phone, email }
}

function parseCheckoutMode(value: unknown): CheckoutMode {
  if (value === undefined || value === null || value === '') {
    return 'online'
  }

  if (value !== 'online' && value !== 'whatsapp') {
    throw new Error('checkout_mode debe ser online o whatsapp.')
  }

  return value
}

function createPaymentSessionToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

function parsePositiveInteger(value: unknown, field: string) {
  if (typeof value === 'string' && !/^[1-9][0-9]*$/.test(value.trim())) {
    throw new Error(`${field} debe ser un entero positivo.`)
  }

  const numberValue = typeof value === 'number' ? value : Number(value)

  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new Error(`${field} debe ser un entero positivo.`)
  }

  return numberValue
}

function parseRequiredString(value: unknown, field: string, maxLength: number) {
  const normalized = parseOptionalString(value, field, maxLength)

  if (!normalized) {
    throw new Error(`${field} es requerido.`)
  }

  return normalized
}

function parseOptionalString(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value !== 'string') {
    throw new Error(`${field} debe ser texto.`)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.length > maxLength) {
    throw new Error(`${field} excede el maximo de ${maxLength} caracteres.`)
  }

  return trimmed
}

async function readLimitedBody(request: Request, maxBytes: number) {
  const contentLength = request.headers.get('content-length')
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error('La solicitud es demasiado grande.')
  }

  if (!request.body) {
    throw new Error('Solicitud vacia.')
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0

  while (true) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    receivedBytes += value.byteLength
    if (receivedBytes > maxBytes) {
      await reader.cancel()
      throw new Error('La solicitud es demasiado grande.')
    }

    chunks.push(value)
  }

  const body = new Uint8Array(receivedBytes)
  let offset = 0

  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(body)
}

function parseAllowedOrigins(value: string) {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

function getCorsHeaders(origin: string | null, allowedOrigins: string[]) {
  if (!origin || allowedOrigins.length === 0 || !allowedOrigins.includes(origin)) {
    return null
  }

  return {
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  corsHeaders: Record<string, string> | null = null,
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(corsHeaders ?? {}),
      ...extraHeaders,
    },
    status,
  })
}

function getStatusForDatabaseError(message: string) {
  if (
    message.includes('producto no disponible') ||
    message.includes('producto invalido') ||
    message.includes('tienda invalida') ||
    message.includes('payload') ||
    message.includes('comprador invalido') ||
    message.includes('whatsapp_message invalido') ||
    message.includes('monto de producto invalido') ||
    message.includes('total de orden invalido') ||
    message.includes('sesion de pago') ||
    message.includes('expiracion de sesion de pago invalida')
  ) {
    return 400
  }

  if (message.includes('idempotency')) {
    return 409
  }

  return 500
}

function getSafeDatabaseError(message: string) {
  const allowedMessages = [
    'tienda invalida',
    'idempotency key requerida',
    'payload de productos invalido',
    'cantidad o producto invalido',
    'producto invalido o producto no disponible',
    'comprador invalido',
    'whatsapp_message invalido',
    'monto de producto invalido',
    'total de orden invalido',
    'sesion de pago invalida',
    'expiracion de sesion de pago invalida',
    'idempotency key conflict',
  ]

  if (allowedMessages.some((allowedMessage) => message.includes(allowedMessage))) {
    return message
  }

  return 'No se pudo crear la orden.'
}
