#!/usr/bin/env node
// Ejecutar con un archivo local ignorado por Git, por ejemplo:
// node --env-file=.env.payment-claim.local --test scripts/payment-claim.integration.test.mjs
//
// Requiere que la migracion 008 ya este aplicada en Supabase remoto.
// Crea una orden de prueba y un intento de pago simulado; no llama a Culqi.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createClient } from '@supabase/supabase-js'

const TEST_MARKER = 'Kafka Payments 3B integration test - claim concurrency'
const TEST_EMAIL = 'payments-integration-test@example.com'
const TEST_PHONE = '+51999999999'
const testOptions = { concurrency: false }

assertSimulatedPaymentTestsAllowed()
assertNoCulqiCredentialsConfigured()

const config = {
  supabaseUrl: readRequiredEnv('SUPABASE_URL', [
    process.env.SUPABASE_URL,
    process.env.VITE_SUPABASE_URL,
  ]),
  serviceRoleKey: readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY', [
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ]),
  createOrderFunctionUrl:
    process.env.CREATE_ORDER_FUNCTION_URL ??
    'http://127.0.0.1:54321/functions/v1/create-order',
  origin: process.env.CREATE_ORDER_TEST_ORIGIN ?? 'http://localhost:5173',
  storeId: readSafeIntegerEnv('PAYMENT_CLAIM_TEST_STORE_ID', '1'),
  validProductId: readSafeIntegerEnv('PAYMENT_CLAIM_VALID_PRODUCT_ID'),
  validProductFinalUnitCents: readSafeIntegerEnv(
    'PAYMENT_CLAIM_VALID_PRODUCT_FINAL_UNIT_CENTS',
  ),
}

assertUrlIsNotCulqi(config.supabaseUrl, 'SUPABASE_URL')
assertUrlIsNotCulqi(config.createOrderFunctionUrl, 'CREATE_ORDER_FUNCTION_URL')
assertLooksLikeServiceRoleKey(config.serviceRoleKey)

const serviceClient = createClient(config.supabaseUrl, config.serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  global: {
    headers: {
      'X-Client-Info': 'kafka-admin-payment-claim-integration-test',
    },
  },
})

test('claim_kafka_payment_attempt_processing allows only one concurrent acquirer', testOptions, async () => {
  const order = await createTestOrder({ label: 'claim-concurrency' })
  const attempt = await reserveAttempt({
    orderId: order.id,
    idempotencyKey: testIdempotencyKey('claim'),
    sourceId: testSourceId('claim'),
  })

  assert.equal(attempt.status, 'created')

  const [firstClaim, secondClaim] = await Promise.all([
    claimAttempt(attempt.id),
    claimAttempt(attempt.id),
  ])

  const acquiredClaims = [firstClaim, secondClaim].filter((claim) => claim.acquired)
  const rejectedClaims = [firstClaim, secondClaim].filter((claim) => !claim.acquired)

  assert.equal(acquiredClaims.length, 1)
  assert.equal(rejectedClaims.length, 1)
  assert.equal(acquiredClaims[0].reason, 'claimed')
  assert.match(rejectedClaims[0].reason, /already_processing|lost_race/)
  assert.equal(acquiredClaims[0].payment_attempt.id, attempt.id)
  assert.equal(rejectedClaims[0].payment_attempt.id, attempt.id)
  assert.equal(acquiredClaims[0].payment_attempt.status, 'processing')
  assert.equal(rejectedClaims[0].payment_attempt.status, 'processing')
  assertDoesNotExposeSecrets(firstClaim)
  assertDoesNotExposeSecrets(secondClaim)
})

async function createTestOrder({ label }) {
  assertSafeTestLabel(label)

  const response = await fetch(config.createOrderFunctionUrl, {
    body: JSON.stringify({
      store_id: config.storeId,
      items: [{ product_id: config.validProductId, quantity: 1 }],
      customer: {
        name: `Integration Test Buyer ${label}`,
        phone: TEST_PHONE,
        email: TEST_EMAIL,
      },
      idempotency_key: testIdempotencyKey(`order-${label}`),
      whatsapp_message: `${TEST_MARKER} - ${label}`,
    }),
    headers: {
      'Content-Type': 'application/json',
      Origin: config.origin,
    },
    method: 'POST',
  })

  if (response.status !== 201) {
    const body = await safeReadJson(response)
    throw new Error(
      `create-order failed for ${label}. Status=${response.status}. Error=${sanitizeText(
        body?.error ?? JSON.stringify(body),
      )}`,
    )
  }

  const body = await readJson(response)
  assert.equal(body.order.store_id, config.storeId)
  assert.equal(body.order.status, 'pending_payment')
  assert.equal(body.order.total_amount_cents, config.validProductFinalUnitCents)

  return body.order
}

async function reserveAttempt({ orderId, idempotencyKey, sourceId }) {
  const { data, error } = await rpc('reserve_kafka_payment_attempt', {
    p_store_id: config.storeId,
    p_order_id: orderId,
    p_idempotency_key: idempotencyKey,
    p_culqi_source_id: sourceId,
  })

  assert.ifError(error)
  assert.equal(data.store_id, config.storeId)
  assert.equal(data.order_id, orderId)
  return data
}

async function claimAttempt(attemptId) {
  const { data, error } = await rpc('claim_kafka_payment_attempt_processing', {
    p_store_id: config.storeId,
    p_payment_attempt_id: attemptId,
  })

  assert.ifError(error)
  assert.equal(data.payment_attempt.id, attemptId)
  return data
}

async function rpc(name, args) {
  const result = await serviceClient.rpc(name, args)

  if (result.error) {
    return {
      data: result.data,
      error: {
        ...result.error,
        message: sanitizeText(result.error.message),
      },
    }
  }

  return result
}

async function readJson(response) {
  const text = await response.text()

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Expected JSON response. Status=${response.status}`)
  }
}

async function safeReadJson(response) {
  try {
    return await readJson(response)
  } catch {
    return null
  }
}

function assertDoesNotExposeSecrets(value) {
  const serialized = JSON.stringify(value)

  assert.doesNotMatch(serialized, /sk_test_/)
  assert.doesNotMatch(serialized, /pk_test_/)
  assert.doesNotMatch(serialized, /tkn_test_/)
  assert.doesNotMatch(serialized, /ype_test_/)
  assert.doesNotMatch(serialized, /crd_test_/)
}

function assertSimulatedPaymentTestsAllowed() {
  if (process.env.ALLOW_SIMULATED_PAYMENT_TESTS !== 'true') {
    throw new Error(
      'ALLOW_SIMULATED_PAYMENT_TESTS=true es requerido para crear ordenes e intentos simulados.',
    )
  }
}

function assertNoCulqiCredentialsConfigured() {
  const forbiddenNames = [
    'CULQI_TEST_PUBLIC_KEY',
    'CULQI_TEST_PRIVATE_KEY',
    'CULQI_TEST_WEBHOOK_SECRET',
    'CULQI_LIVE_PUBLIC_KEY',
    'CULQI_LIVE_PRIVATE_KEY',
    'CULQI_LIVE_WEBHOOK_SECRET',
  ].filter((name) => process.env[name])

  if (forbiddenNames.length > 0) {
    throw new Error(
      `No cargues credenciales Culqi para estas pruebas. Variables detectadas: ${forbiddenNames.join(
        ', ',
      )}.`,
    )
  }
}

function assertLooksLikeServiceRoleKey(value) {
  if (!value || value.length < 20) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY no parece valida.')
  }
}

function assertSafeTestLabel(label) {
  if (!/^[a-z0-9-]+$/.test(label)) {
    throw new Error(`Etiqueta de prueba invalida: ${sanitizeText(label)}`)
  }
}

function assertUrlIsNotCulqi(value, name) {
  let hostname

  try {
    hostname = new URL(value).hostname
  } catch {
    throw new Error(`${name} debe ser una URL valida.`)
  }

  if (/(^|\.)culqi\.(com|dev|test)$/i.test(hostname)) {
    throw new Error(`${name} no debe apuntar a Culqi. Estas pruebas no llaman la API de Culqi.`)
  }
}

function testIdempotencyKey(label) {
  return `it-payment-claim-${label}-${Date.now()}-${randomUUID()}`
}

function testSourceId(label) {
  return `tkn_test_${compactTestId(label)}${compactTestId(randomUUID())}`
}

function compactTestId(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, '')
}

function sanitizeText(value) {
  return String(value)
    .replace(/sk_test_[A-Za-z0-9]+/g, '[redacted_private_key]')
    .replace(/pk_test_[A-Za-z0-9]+/g, '[redacted_public_key]')
    .replace(/tkn_test_[A-Za-z0-9]+/g, '[redacted_token]')
    .replace(/ype_test_[A-Za-z0-9]+/g, '[redacted_token]')
    .replace(/crd_test_[A-Za-z0-9]+/g, '[redacted_token]')
    .replace(/eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/g, '[redacted_jwt]')
}

function readRequiredEnv(name, values) {
  const value = values.find((candidate) => candidate?.trim())

  if (!value) {
    throw new Error(`${name} debe estar definido.`)
  }

  return value.trim()
}

function readSafeIntegerEnv(name, defaultValue = undefined) {
  const value = process.env[name] ?? defaultValue

  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} debe estar definido como entero positivo.`)
  }

  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} excede Number.MAX_SAFE_INTEGER.`)
  }

  return parsed
}
