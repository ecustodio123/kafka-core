import { assert, assertEquals, assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createHandler } from './index.ts'

const ORIGIN = 'http://localhost:5173'
const STORE_ID = 1
const ORDER_ID = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-10-13T12:00:00.000Z')

Deno.test('online order creates a one-time payment session token', async () => {
  const fake = createFakeSupabase({ paymentSessionCreated: true })
  const response = await post(createTestHandler(fake))
  const body = await response.json()
  const rpcCall = fake.calls[0]

  assertEquals(response.status, 201)
  assertEquals(body.order.id, ORDER_ID)
  assertMatch(body.payment_session.token, /^[A-Za-z0-9_-]{43}$/)
  assertEquals(body.payment_session.expires_at, '2026-10-13T12:15:00.000Z')
  assertEquals(rpcCall.name, 'create_kafka_online_order_with_payment_session')
  assertEquals(rpcCall.args.p_payment_session_expires_at, '2026-10-13T12:15:00.000Z')
  assertMatch(String(rpcCall.args.p_payment_session_token_hash), /^[a-f0-9]{64}$/)
  assertEquals(JSON.stringify(body).includes(String(rpcCall.args.p_payment_session_token_hash)), false)
})

Deno.test('idempotent online replay returns the order without recovering a token', async () => {
  const fake = createFakeSupabase({ paymentSessionCreated: false })
  const response = await post(createTestHandler(fake))
  const body = await response.json()

  assertEquals(response.status, 201)
  assertEquals(body.order.id, ORDER_ID)
  assertEquals('payment_session' in body, false)
})

Deno.test('whatsapp checkout keeps the existing order flow without payment session', async () => {
  const fake = createFakeSupabase()
  const response = await post(createTestHandler(fake), { checkout_mode: 'whatsapp' })
  const body = await response.json()

  assertEquals(response.status, 201)
  assertEquals(body.order.id, ORDER_ID)
  assertEquals(fake.calls[0].name, 'create_kafka_order')
  assertEquals('payment_session' in body, false)
})

Deno.test('invalid checkout mode is rejected before touching the database', async () => {
  const fake = createFakeSupabase()
  const response = await post(createTestHandler(fake), { checkout_mode: 'cash' })
  const body = await response.json()

  assertEquals(response.status, 400)
  assertMatch(body.error, /checkout_mode/i)
  assertEquals(fake.calls.length, 0)
})

function createTestHandler(fake: ReturnType<typeof createFakeSupabase>) {
  return createHandler({
    createSupabaseClient: () => fake,
    env: (name) => {
      if (name === 'CREATE_ORDER_ALLOWED_ORIGINS') {
        return ORIGIN
      }

      return undefined
    },
    now: () => NOW,
  })
}

async function post(
  handler: (request: Request) => Promise<Response>,
  payloadOverrides: Record<string, unknown> = {},
) {
  return await handler(
    new Request('http://localhost/functions/v1/create-order', {
      body: JSON.stringify({
        store_id: STORE_ID,
        items: [{ product_id: 1, quantity: 2 }],
        customer: {
          name: 'Kafka Buyer',
          phone: '+51999999999',
          email: 'buyer@example.com',
        },
        idempotency_key: 'order-key',
        whatsapp_message: 'Kafka order message',
        ...payloadOverrides,
      }),
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
      },
      method: 'POST',
    }),
  )
}

function createFakeSupabase({
  paymentSessionCreated = true,
}: { paymentSessionCreated?: boolean } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const order = {
    id: ORDER_ID,
    store_id: STORE_ID,
    status: 'pending_payment',
    currency: 'PEN',
    total_amount_cents: 2000,
    items: [],
  }

  return {
    calls,
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args })

      if (name === 'create_kafka_online_order_with_payment_session') {
        return {
          data: {
            order,
            payment_session_created: paymentSessionCreated,
            payment_session: paymentSessionCreated
              ? { expires_at: args.p_payment_session_expires_at }
              : undefined,
          },
          error: null,
        }
      }

      if (name === 'create_kafka_order') {
        assert(!('p_payment_session_token_hash' in args))
        return { data: order, error: null }
      }

      return { data: null, error: { message: `RPC inesperado: ${name}` } }
    },
  }
}
