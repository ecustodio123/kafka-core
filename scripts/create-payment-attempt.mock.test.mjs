#!/usr/bin/env node
// Ejecutar con un archivo local ignorado por Git, por ejemplo:
// node --env-file=.env.create-payment-attempt-mock.local --test scripts/create-payment-attempt.mock.test.mjs

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

const TEST_MARKER = 'Kafka Payments 3B integration test - create-payment-attempt MOCK'
const testOptions = { concurrency: false }

assertSimulatedPaymentTestsAllowed()
assertNoCulqiCredentialsConfigured()

const config = {
  createOrderFunctionUrl:
    process.env.CREATE_ORDER_FUNCTION_URL ??
    'http://127.0.0.1:54321/functions/v1/create-order',
  createPaymentAttemptFunctionUrl:
    process.env.CREATE_PAYMENT_ATTEMPT_FUNCTION_URL ??
    'http://127.0.0.1:54321/functions/v1/create-payment-attempt',
  origin: process.env.CREATE_PAYMENT_ATTEMPT_TEST_ORIGIN ?? 'http://localhost:5173',
  storeId: readSafeIntegerEnv('CREATE_PAYMENT_ATTEMPT_TEST_STORE_ID', '1'),
  validProductId: readSafeIntegerEnv('CREATE_PAYMENT_ATTEMPT_VALID_PRODUCT_ID'),
  expectedFinalUnitCents: readSafeIntegerEnv(
    'CREATE_PAYMENT_ATTEMPT_VALID_PRODUCT_FINAL_UNIT_CENTS',
  ),
  expectedMockResult: readMockResultEnv('CREATE_PAYMENT_ATTEMPT_EXPECTED_MOCK_RESULT'),
  testRunnerSecret: readRequiredEnv('CREATE_PAYMENT_ATTEMPT_MOCK_TEST_RUNNER_SECRET'),
}

assertUrlIsNotCulqi(config.createOrderFunctionUrl, 'CREATE_ORDER_FUNCTION_URL')
assertUrlIsNotCulqi(
  config.createPaymentAttemptFunctionUrl,
  'CREATE_PAYMENT_ATTEMPT_FUNCTION_URL',
)

test('create-payment-attempt MOCK processes a new order and is idempotent', testOptions, async () => {
  const order = await createTestOrder()
  const idempotencyKey = testIdempotencyKey('payment')
  const sourceId = testSourceId()

  const firstResponse = await postCreatePaymentAttempt({
    store_id: config.storeId,
    order_id: order.id,
    idempotency_key: idempotencyKey,
    source_id: sourceId,
  })

  assertExpectedFirstPaymentResponse(firstResponse)
  assertDoesNotExposeSecrets(firstResponse)
  assert.equal(firstResponse.payment_attempt.order_id, order.id)
  assert.equal(firstResponse.payment_attempt.store_id, config.storeId)
  assert.equal(firstResponse.payment_attempt.amount_cents, config.expectedFinalUnitCents)
  assert.equal(firstResponse.payment_attempt.currency, 'PEN')

  const secondResponse = await postCreatePaymentAttempt({
    store_id: config.storeId,
    order_id: order.id,
    idempotency_key: idempotencyKey,
    source_id: sourceId,
  })

  assert.equal(secondResponse.payment_attempt.id, firstResponse.payment_attempt.id)
  assert.equal(secondResponse.mock.processed, false)
  assert.equal(secondResponse.mock.reason, 'existing_attempt')
  assertDoesNotExposeSecrets(secondResponse)
})

test('create-payment-attempt MOCK rejects client-selected result fields', testOptions, async () => {
  const order = await createTestOrder()
  const response = await fetch(config.createPaymentAttemptFunctionUrl, {
    body: JSON.stringify({
      store_id: config.storeId,
      order_id: order.id,
      idempotency_key: testIdempotencyKey('forbidden-field'),
      source_id: testSourceId(),
      mock_result: 'success',
    }),
    headers: {
      'Content-Type': 'application/json',
      Origin: config.origin,
      'x-kafka-mock-test-secret': config.testRunnerSecret,
    },
    method: 'POST',
  })

  assert.equal(response.status, 400)
  const body = await readJson(response)
  assert.match(body.error, /mock_result no esta permitido/i)
  assertDoesNotExposeSecrets(body)
})

async function createTestOrder() {
  const response = await fetch(config.createOrderFunctionUrl, {
    body: JSON.stringify({
      store_id: config.storeId,
      items: [{ product_id: config.validProductId, quantity: 1 }],
      customer: {
        name: 'Integration Test Buyer create-payment-attempt mock',
        phone: '+51999999999',
        email: 'payments-integration-test@example.com',
      },
      idempotency_key: testIdempotencyKey('order'),
      whatsapp_message: `${TEST_MARKER} - simulated data`,
    }),
    headers: {
      'Content-Type': 'application/json',
      Origin: config.origin,
      'x-kafka-mock-test-secret': config.testRunnerSecret,
    },
    method: 'POST',
  })

  if (response.status !== 201) {
    const body = await safeReadJson(response)
    throw new Error(
      `create-order failed. Status=${response.status}. Error=${sanitizeText(
        body?.error ?? JSON.stringify(body),
      )}`,
    )
  }

  const body = await readJson(response)
  assert.equal(body.order.store_id, config.storeId)
  assert.equal(body.order.status, 'pending_payment')
  assert.equal(body.order.total_amount_cents, config.expectedFinalUnitCents)

  return body.order
}

async function postCreatePaymentAttempt(payload) {
  const response = await fetch(config.createPaymentAttemptFunctionUrl, {
    body: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json',
      Origin: config.origin,
      'x-kafka-mock-test-secret': config.testRunnerSecret,
    },
    method: 'POST',
  })

  const body = await readJson(response)

  if (!response.ok && response.status !== 402) {
    throw new Error(
      `create-payment-attempt failed. Status=${response.status}. Error=${sanitizeText(
        body?.error ?? JSON.stringify(body),
      )}`,
    )
  }

  return body
}

function assertExpectedFirstPaymentResponse(body) {
  assert.equal(body.mock.mode, 'mock')
  assert.equal(body.mock.processed, true)
  assert.equal(body.mock.result, config.expectedMockResult)

  if (config.expectedMockResult === 'success') {
    assert.equal(body.payment_attempt.status, 'paid')
    assert.equal(body.payment_attempt.order_status, 'paid')
    assert.match(body.payment_attempt.culqi_charge_id, /^chr_test_mock_/)
    return
  }

  if (config.expectedMockResult === 'failed') {
    assert.equal(body.payment_attempt.status, 'failed')
    assert.equal(body.payment_attempt.order_status, 'payment_failed')
    assert.equal(body.payment_attempt.failure_code, 'mock_definitive_rejection')
    return
  }

  assert.equal(body.payment_attempt.status, 'processing')
  assert.equal(body.payment_attempt.order_status, 'pending_payment')
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

function assertSimulatedPaymentTestsAllowed() {
  if (process.env.ALLOW_SIMULATED_PAYMENT_TESTS !== 'true') {
    throw new Error(
      'ALLOW_SIMULATED_PAYMENT_TESTS=true es requerido para crear pagos MOCK.',
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
      `No cargues credenciales Culqi para estas pruebas MOCK. Variables detectadas: ${forbiddenNames.join(
        ', ',
      )}.`,
    )
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

function testIdempotencyKey(label) {
  return `it-create-payment-attempt-${label}-${Date.now()}-${randomUUID()}`
}

function testSourceId() {
  return `tkn_test_${randomUUID().replace(/[^A-Za-z0-9]/g, '')}`
}

function readMockResultEnv(name) {
  const value = process.env[name]

  if (value !== 'success' && value !== 'failed' && value !== 'uncertain') {
    throw new Error(`${name} debe ser success, failed o uncertain.`)
  }

  return value
}

function readRequiredEnv(name) {
  const value = process.env[name]

  if (!value?.trim()) {
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

function assertUrlIsNotCulqi(value, name) {
  let hostname

  try {
    hostname = new URL(value).hostname
  } catch {
    throw new Error(`${name} debe ser una URL valida.`)
  }

  if (/(^|\.)culqi\.(com|dev|test)$/i.test(hostname)) {
    throw new Error(`${name} no debe apuntar a Culqi. Estas pruebas no llaman Culqi.`)
  }
}

function sanitizeText(value) {
  return String(value)
    .replace(/sk_test_[A-Za-z0-9]+/g, '[redacted_private_key]')
    .replace(/pk_test_[A-Za-z0-9]+/g, '[redacted_public_key]')
    .replace(/tkn_test_[A-Za-z0-9]+/g, '[redacted_source]')
    .replace(/ype_test_[A-Za-z0-9]+/g, '[redacted_source]')
    .replace(/crd_test_[A-Za-z0-9]+/g, '[redacted_source]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted_jwt]')
}
