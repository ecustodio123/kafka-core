#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

const config = {
  functionUrl:
    process.env.CREATE_ORDER_FUNCTION_URL ??
    'http://127.0.0.1:54321/functions/v1/create-order',
  origin: process.env.CREATE_ORDER_TEST_ORIGIN ?? 'http://localhost:5173',
  storeId: readSafeIntegerEnv('CREATE_ORDER_TEST_STORE_ID'),
  validProductId: readSafeIntegerEnv('CREATE_ORDER_VALID_PRODUCT_ID'),
  otherStoreProductId: readSafeIntegerEnv('CREATE_ORDER_OTHER_STORE_PRODUCT_ID'),
  inactiveProductId: readSafeIntegerEnv('CREATE_ORDER_INACTIVE_PRODUCT_ID'),
  validProductFinalUnitCents: readSafeIntegerEnv(
    'CREATE_ORDER_VALID_PRODUCT_FINAL_UNIT_CENTS',
  ),
}

test('create-order creates a valid order and calculates prices on the server', async () => {
  const quantity = 2
  const payload = buildPayload({
    idempotencyKey: testIdempotencyKey(),
    items: [
      {
        product_id: config.validProductId,
        quantity,
        price: 1,
        discount_price: 1,
        final_unit_price_cents: 1,
      },
    ],
  })

  const response = await postCreateOrder(payload)

  assert.equal(response.status, 201)
  assert.equal(response.headers.get('access-control-allow-origin'), config.origin)

  const body = await readJson(response)
  assert.equal(body.order.store_id, config.storeId)
  assert.equal(body.order.currency, 'PEN')
  assert.equal(body.order.status, 'pending_payment')
  assert.equal(
    body.order.total_amount_cents,
    config.validProductFinalUnitCents * quantity,
  )
  assert.equal(body.order.items.length, 1)
  assert.equal(body.order.items[0].product_id, config.validProductId)
  assert.equal(body.order.items[0].quantity, quantity)
  assert.equal(body.order.items[0].final_unit_price_cents, config.validProductFinalUnitCents)
  assert.equal(
    body.order.items[0].line_total_cents,
    config.validProductFinalUnitCents * quantity,
  )
})

test('create-order returns the same order for the same idempotent request', async () => {
  const payload = buildPayload({
    idempotencyKey: testIdempotencyKey(),
    items: [{ product_id: config.validProductId, quantity: 1 }],
  })

  const firstResponse = await postCreateOrder(payload)
  assert.equal(firstResponse.status, 201)
  const firstBody = await readJson(firstResponse)

  const secondResponse = await postCreateOrder(payload)
  assert.equal(secondResponse.status, 201)
  const secondBody = await readJson(secondResponse)

  assert.equal(secondBody.order.id, firstBody.order.id)
  assert.equal(secondBody.order.total_amount_cents, firstBody.order.total_amount_cents)
})

test('create-order rejects an idempotency key reused with a different request', async () => {
  const idempotencyKey = testIdempotencyKey()
  const firstPayload = buildPayload({
    idempotencyKey,
    items: [{ product_id: config.validProductId, quantity: 1 }],
  })
  const conflictPayload = buildPayload({
    idempotencyKey,
    customer: {
      name: 'Integration Test Buyer',
      phone: '+51999999998',
      email: 'checkout-test@example.com',
    },
    items: [{ product_id: config.validProductId, quantity: 1 }],
  })

  const firstResponse = await postCreateOrder(firstPayload)
  assert.equal(firstResponse.status, 201)

  const conflictResponse = await postCreateOrder(conflictPayload)
  assert.equal(conflictResponse.status, 409)

  const conflictBody = await readJson(conflictResponse)
  assert.match(conflictBody.error, /idempotency key conflict/i)
})

test('create-order rejects a product from another store', async () => {
  const response = await postCreateOrder(
    buildPayload({
      idempotencyKey: testIdempotencyKey(),
      items: [{ product_id: config.otherStoreProductId, quantity: 1 }],
    }),
  )

  assert.equal(response.status, 400)
  const body = await readJson(response)
  assert.match(body.error, /producto invalido|producto no disponible/i)
})

test('create-order rejects an inactive or unavailable product', async () => {
  const response = await postCreateOrder(
    buildPayload({
      idempotencyKey: testIdempotencyKey(),
      items: [{ product_id: config.inactiveProductId, quantity: 1 }],
    }),
  )

  assert.equal(response.status, 400)
  const body = await readJson(response)
  assert.match(body.error, /producto invalido|producto no disponible/i)
})

function buildPayload({
  idempotencyKey,
  items,
  customer = {
    name: 'Integration Test Buyer',
    phone: '+51999999999',
    email: 'checkout-test@example.com',
  },
}) {
  return {
    store_id: config.storeId,
    items,
    customer,
    idempotency_key: idempotencyKey,
    whatsapp_message: 'Integration test order',
  }
}

async function postCreateOrder(payload) {
  const response = await fetch(config.functionUrl, {
    body: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json',
      Origin: config.origin,
    },
    method: 'POST',
  })

  if (response.status === 401) {
    throw new Error(
      'create-order devolvio 401. Revisa supabase/config.toml: [functions.create-order] verify_jwt = false.',
    )
  }

  if (response.status === 403) {
    throw new Error(
      `create-order devolvio 403. Revisa CREATE_ORDER_ALLOWED_ORIGINS e incluye ${config.origin}.`,
    )
  }

  return response
}

async function readJson(response) {
  const text = await response.text()

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Expected JSON response. Status=${response.status}`)
  }
}

function testIdempotencyKey() {
  return `it-create-order-${Date.now()}-${randomUUID()}`
}

function readSafeIntegerEnv(name) {
  const value = process.env[name]

  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} debe estar definido como entero positivo.`)
  }

  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} excede Number.MAX_SAFE_INTEGER.`)
  }

  return parsed
}
