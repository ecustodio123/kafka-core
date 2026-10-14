import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3'

const MAX_BODY_BYTES = 1024
const TEST_ENVIRONMENT = 'test'

const allowedOrigins = parseAllowedOrigins(
  Deno.env.get('GET_PAYMENT_CONFIG_ALLOWED_ORIGINS') ??
    Deno.env.get('CREATE_ORDER_ALLOWED_ORIGINS') ??
    '',
)

serve(async (request) => {
  const origin = request.headers.get('origin')
  const corsHeaders = getCorsHeaders(origin)

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders,
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
    const storeId = parseStoreId(JSON.parse(rawBody))

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse(
        { error: 'Configuracion de servidor incompleta.' },
        500,
        corsHeaders,
      )
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: {
          'X-Client-Info': 'kafka-payments-get-payment-config',
        },
      },
    })

    const { data, error } = await supabase
      .from('store_payment_settings')
      .select('culqi_public_key, culqi_enabled, currency')
      .eq('store_id', storeId)
      .eq('provider', 'culqi')
      .eq('environment', TEST_ENVIRONMENT)
      .eq('active', true)
      .maybeSingle()

    if (error) {
      return jsonResponse(
        { error: 'No se pudo consultar la configuracion de pagos.' },
        500,
        corsHeaders,
      )
    }

    if (!data) {
      return jsonResponse(
        {
          store_id: storeId,
          provider: 'culqi',
          environment: TEST_ENVIRONMENT,
          currency: 'PEN',
          enabled: false,
          culqi_public_key: null,
        },
        200,
        corsHeaders,
      )
    }

    const enabled = Boolean(data.culqi_enabled && data.culqi_public_key)

    return jsonResponse(
      {
        store_id: storeId,
        provider: 'culqi',
        environment: TEST_ENVIRONMENT,
        currency: data.currency,
        enabled,
        culqi_public_key: enabled ? data.culqi_public_key : null,
      },
      200,
      corsHeaders,
    )
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : 'Solicitud invalida.' },
      400,
      corsHeaders,
    )
  }
})

function parseStoreId(payload: unknown) {
  if (!payload || typeof payload !== 'object' || !('store_id' in payload)) {
    throw new Error('store_id es requerido.')
  }

  const value = (payload as { store_id: unknown }).store_id

  if (typeof value === 'string' && !/^[1-9][0-9]*$/.test(value.trim())) {
    throw new Error('store_id debe ser un entero positivo.')
  }

  const parsed = typeof value === 'number' ? value : Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('store_id debe ser un entero positivo.')
  }

  return parsed
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

function getCorsHeaders(origin: string | null) {
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
