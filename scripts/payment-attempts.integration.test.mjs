#!/usr/bin/env node
// Ejecutar con un archivo local ignorado por Git, por ejemplo:
// node --env-file=.env.payment-attempts.local --test scripts/payment-attempts.integration.test.mjs
//
// El archivo local debe incluir ALLOW_SIMULATED_PAYMENT_TESTS=true y no debe
// incluir credenciales Culqi. Estas pruebas no llaman la API de Culqi.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createClient } from '@supabase/supabase-js'

const TEST_MARKER = 'Kafka Payments 3B integration test - simulated data'
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
  publishableKey: readRequiredEnv('SUPABASE_PUBLISHABLE_KEY', [
    process.env.SUPABASE_PUBLISHABLE_KEY,
    process.env.SUPABASE_ANON_KEY,
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  ]),
  authJwt: readRequiredEnv('PAYMENT_RPC_AUTH_JWT', [
    process.env.PAYMENT_RPC_AUTH_JWT,
    process.env.SUPABASE_AUTH_JWT,
  ]),
  createOrderFunctionUrl:
    process.env.CREATE_ORDER_FUNCTION_URL ??
    'http://127.0.0.1:54321/functions/v1/create-order',
  origin: process.env.CREATE_ORDER_TEST_ORIGIN ?? 'http://localhost:5173',
  storeId: readSafeIntegerEnv('PAYMENT_RPC_TEST_STORE_ID', '1'),
  validProductId: readSafeIntegerEnv('PAYMENT_RPC_VALID_PRODUCT_ID'),
  validProductFinalUnitCents: readSafeIntegerEnv(
    'PAYMENT_RPC_VALID_PRODUCT_FINAL_UNIT_CENTS',
  ),
}

assertUrlIsNotCulqi(config.supabaseUrl, 'SUPABASE_URL')
assertUrlIsNotCulqi(config.createOrderFunctionUrl, 'CREATE_ORDER_FUNCTION_URL')
assertLooksLikeServiceRoleKey(config.serviceRoleKey)
assertLooksLikeJwt(config.authJwt)

const serviceClient = createClient(config.supabaseUrl, config.serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  global: {
    headers: {
      'X-Client-Info': 'kafka-admin-payment-attempts-integration-test',
    },
  },
})

const anonClient = createClient(config.supabaseUrl, config.publishableKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  global: {
    headers: {
      'X-Client-Info': 'kafka-admin-payment-attempts-integration-test-anon',
    },
  },
})

const authenticatedClient = createClient(config.supabaseUrl, config.publishableKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  global: {
    headers: {
      Authorization: `Bearer ${config.authJwt}`,
      'X-Client-Info': 'kafka-admin-payment-attempts-integration-test-auth',
    },
  },
})

test('payment RPCs reserve an attempt and return the same attempt for the same idempotent request', testOptions, async () => {
  const order = await createTestOrder({ label: 'valid-reservation' })
  const idempotencyKey = testIdempotencyKey('reserve')
  const sourceId = testSourceId('same')

  const firstAttempt = await reserveAttempt({
    orderId: order.id,
    idempotencyKey,
    sourceId,
  })
  const secondAttempt = await reserveAttempt({
    orderId: order.id,
    idempotencyKey,
    sourceId,
  })

  assert.equal(firstAttempt.id, secondAttempt.id)
  assert.equal(firstAttempt.order_id, order.id)
  assert.equal(firstAttempt.store_id, config.storeId)
  assert.equal(firstAttempt.status, 'created')
  assert.equal(firstAttempt.order_status, 'pending_payment')
  assert.equal(firstAttempt.environment, 'test')
  assert.equal(firstAttempt.provider, 'culqi')
  assert.equal(firstAttempt.currency, 'PEN')
  assert.equal(firstAttempt.amount_cents, config.validProductFinalUnitCents)
  assertDoesNotExposeSecrets(firstAttempt)
})

test('payment RPCs reject a reused idempotency key with a different source id', testOptions, async () => {
  const order = await createTestOrder({ label: 'idempotency-conflict' })
  const idempotencyKey = testIdempotencyKey('conflict')

  const firstAttempt = await reserveAttempt({
    orderId: order.id,
    idempotencyKey,
    sourceId: testSourceId('original'),
  })

  assert.equal(firstAttempt.status, 'created')

  const { error } = await rpc('reserve_kafka_payment_attempt', {
    p_store_id: config.storeId,
    p_order_id: order.id,
    p_idempotency_key: idempotencyKey,
    p_culqi_source_id: testSourceId('changed'),
  })

  assert(error, 'Expected idempotency conflict error')
  assert.match(error.message, /idempotency key conflict/i)
})

test('payment RPCs prevent simultaneous active attempts for the same order', testOptions, async () => {
  const order = await createTestOrder({ label: 'active-attempt-block' })

  const firstAttempt = await reserveAttempt({
    orderId: order.id,
    idempotencyKey: testIdempotencyKey('active-a'),
    sourceId: testSourceId('active-a'),
  })

  assert.equal(firstAttempt.status, 'created')

  const { error } = await rpc('reserve_kafka_payment_attempt', {
    p_store_id: config.storeId,
    p_order_id: order.id,
    p_idempotency_key: testIdempotencyKey('active-b'),
    p_culqi_source_id: testSourceId('active-b'),
  })

  assert(error, 'Expected active attempt conflict error')
  assert.match(error.message, /intento de pago pendiente/i)
})

test('payment RPCs enforce created -> processing -> paid transitions', testOptions, async () => {
  const order = await createTestOrder({ label: 'simulated-paid-transition' })
  const attempt = await reserveAttempt({
    orderId: order.id,
    idempotencyKey: testIdempotencyKey('paid'),
    sourceId: testSourceId('paid'),
  })

  const directPaid = await rpc('finalize_kafka_payment_attempt', {
    p_store_id: config.storeId,
    p_payment_attempt_id: attempt.id,
    p_final_status: 'paid',
    p_culqi_charge_id: testChargeId('direct-paid-blocked'),
    p_sanitized_payload: {
      test: true,
      simulated: true,
      marker: TEST_MARKER,
      reason: 'direct-created-to-paid-should-fail',
    },
  })

  assert(directPaid.error, 'Expected direct created -> paid transition to fail')
  assert.match(directPaid.error.message, /transicion de intento de pago invalida/i)

  const processingAttempt = await markAttemptProcessing(attempt.id)
  assert.equal(processingAttempt.status, 'processing')

  const paidAttempt = await finalizeAttempt({
    attemptId: attempt.id,
    finalStatus: 'paid',
    chargeId: testChargeId('paid'),
    eventId: testProviderEventId('paid'),
    payload: {
      test: true,
      simulated: true,
      marker: TEST_MARKER,
      scenario: 'integration-test-paid-without-culqi-api-call',
    },
  })

  assert.equal(paidAttempt.status, 'paid')
  assert.equal(paidAttempt.order_status, 'paid')
  assert.match(paidAttempt.culqi_charge_id, /^chr_test_/)
  assertDoesNotExposeSecrets(paidAttempt)
})

test('payment RPCs allow a new attempt after a definitive rejection', testOptions, async () => {
  const order = await createTestOrder({ label: 'definitive-rejection-retry' })
  const failedAttempt = await reserveAndProcessAttempt({
    orderId: order.id,
    idempotencyKey: testIdempotencyKey('failed'),
    sourceId: testSourceId('failed'),
  })

  const finalizedFailedAttempt = await finalizeAttempt({
    attemptId: failedAttempt.id,
    finalStatus: 'failed',
    failureCode: 'card_declined_simulated',
    failureMessage: 'Integration test simulated definitive rejection',
    eventId: testProviderEventId('failed'),
    payload: {
      test: true,
      simulated: true,
      marker: TEST_MARKER,
      scenario: 'integration-test-definitive-rejection',
    },
  })

  assert.equal(finalizedFailedAttempt.status, 'failed')
  assert.equal(finalizedFailedAttempt.order_status, 'payment_failed')

  const retryAttempt = await reserveAttempt({
    orderId: order.id,
    idempotencyKey: testIdempotencyKey('retry'),
    sourceId: testSourceId('retry'),
  })

  assert.notEqual(retryAttempt.id, failedAttempt.id)
  assert.equal(retryAttempt.status, 'created')
  assert.equal(retryAttempt.order_status, 'pending_payment')
})

test('payment RPCs do not let a paid order return to pending or failed', testOptions, async () => {
  const order = await createTestOrder({ label: 'paid-order-terminal' })
  const paidAttempt = await reserveAndProcessAttempt({
    orderId: order.id,
    idempotencyKey: testIdempotencyKey('terminal-paid'),
    sourceId: testSourceId('terminal-paid'),
  })

  const finalizedPaidAttempt = await finalizeAttempt({
    attemptId: paidAttempt.id,
    finalStatus: 'paid',
    chargeId: testChargeId('terminal-paid'),
    eventId: testProviderEventId('terminal-paid'),
    payload: {
      test: true,
      simulated: true,
      marker: TEST_MARKER,
      scenario: 'integration-test-terminal-paid-order',
    },
  })

  assert.equal(finalizedPaidAttempt.order_status, 'paid')

  const lateFailedResponse = await finalizeAttempt({
    attemptId: paidAttempt.id,
    finalStatus: 'failed',
    failureCode: 'late_failure_simulated',
    failureMessage: 'Integration test late failure should not revert paid order',
    eventId: testProviderEventId('late-failure'),
    payload: {
      test: true,
      simulated: true,
      marker: TEST_MARKER,
      scenario: 'integration-test-late-failure-after-paid',
    },
  })

  assert.equal(lateFailedResponse.status, 'paid')
  assert.equal(lateFailedResponse.order_status, 'paid')

  const retryAfterPaid = await rpc('reserve_kafka_payment_attempt', {
    p_store_id: config.storeId,
    p_order_id: order.id,
    p_idempotency_key: testIdempotencyKey('retry-paid'),
    p_culqi_source_id: testSourceId('retry-paid'),
  })

  assert(retryAfterPaid.error, 'Expected reserve on paid order to fail')
  assert.match(retryAfterPaid.error.message, /orden ya pagada/i)
})

test('private payment RPCs are not executable by anon or authenticated clients', testOptions, async () => {
  const fakeAttemptId = randomUUID()
  const anonResult = await anonClient.rpc('mark_kafka_payment_attempt_processing', {
    p_store_id: config.storeId,
    p_payment_attempt_id: fakeAttemptId,
  })
  const authenticatedResult = await authenticatedClient.rpc(
    'mark_kafka_payment_attempt_processing',
    {
      p_store_id: config.storeId,
      p_payment_attempt_id: fakeAttemptId,
    },
  )

  assertPermissionDenied(anonResult.error, 'anon')
  assertPermissionDenied(authenticatedResult.error, 'authenticated')
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

async function reserveAndProcessAttempt({ orderId, idempotencyKey, sourceId }) {
  const attempt = await reserveAttempt({ orderId, idempotencyKey, sourceId })
  return markAttemptProcessing(attempt.id)
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

async function markAttemptProcessing(attemptId) {
  const { data, error } = await rpc('mark_kafka_payment_attempt_processing', {
    p_store_id: config.storeId,
    p_payment_attempt_id: attemptId,
  })

  assert.ifError(error)
  assert.equal(data.id, attemptId)
  return data
}

async function finalizeAttempt({
  attemptId,
  finalStatus,
  chargeId = null,
  failureCode = null,
  failureMessage = null,
  eventId,
  payload,
}) {
  const { data, error } = await rpc('finalize_kafka_payment_attempt', {
    p_store_id: config.storeId,
    p_payment_attempt_id: attemptId,
    p_final_status: finalStatus,
    p_culqi_charge_id: chargeId,
    p_failure_code: failureCode,
    p_failure_message: failureMessage,
    p_provider_event_id: eventId,
    p_provider_reference: chargeId,
    p_sanitized_payload: payload,
  })

  assert.ifError(error)
  assert.equal(data.id, attemptId)
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

  assert.equal('idempotency_key' in value, false)
  assert.equal('idempotency_fingerprint' in value, false)
  assert.doesNotMatch(serialized, /sk_test_/)
  assert.doesNotMatch(serialized, /pk_test_/)
  assert.doesNotMatch(serialized, /tkn_test_/)
  assert.doesNotMatch(serialized, /ype_test_/)
  assert.doesNotMatch(serialized, /crd_test_/)
}

function assertPermissionDenied(error, roleName) {
  assert(error, `Expected ${roleName} client to be denied`)
  assert.match(
    error.message,
    /permission denied|not authorized|could not find the function|schema cache/i,
  )
}

function assertSimulatedPaymentTestsAllowed() {
  if (process.env.ALLOW_SIMULATED_PAYMENT_TESTS !== 'true') {
    throw new Error(
      'ALLOW_SIMULATED_PAYMENT_TESTS=true es requerido para crear ordenes e intentos de pago simulados.',
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

function assertLooksLikeJwt(value) {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('PAYMENT_RPC_AUTH_JWT no parece un JWT valido.')
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
  return `it-payment-${label}-${Date.now()}-${randomUUID()}`
}

function testSourceId(label) {
  return `tkn_test_${compactTestId(label)}${compactTestId(randomUUID())}`
}

function testChargeId(label) {
  return `chr_test_${compactTestId(label)}${compactTestId(randomUUID())}`
}

function testProviderEventId(label) {
  return `evt_test_${compactTestId(label)}${compactTestId(randomUUID())}`
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
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted_jwt]')
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
