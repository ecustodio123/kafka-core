#!/usr/bin/env node
import assert from 'node:assert/strict'
import { test } from 'node:test'

const config = {
  functionUrl:
    process.env.GET_PAYMENT_CONFIG_FUNCTION_URL ??
    'http://127.0.0.1:54321/functions/v1/get-payment-config',
  origin: process.env.GET_PAYMENT_CONFIG_TEST_ORIGIN ?? 'http://localhost:5173',
  enabledStoreId: readSafeIntegerEnv('GET_PAYMENT_CONFIG_ENABLED_STORE_ID'),
  enabledPublicKey: readRequiredEnv('GET_PAYMENT_CONFIG_ENABLED_PUBLIC_KEY'),
  disabledStoreId: readSafeIntegerEnv('GET_PAYMENT_CONFIG_DISABLED_STORE_ID'),
  missingStoreId: readSafeIntegerEnv('GET_PAYMENT_CONFIG_MISSING_STORE_ID'),
}

test('get-payment-config returns public Culqi TEST config for an enabled store', async () => {
  const response = await postGetPaymentConfig(config.enabledStoreId)

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), config.origin)

  const body = await readJson(response)

  assert.equal(body.store_id, config.enabledStoreId)
  assert.equal(body.provider, 'culqi')
  assert.equal(body.environment, 'test')
  assert.equal(body.currency, 'PEN')
  assert.equal(body.enabled, true)
  assert.equal(body.culqi_public_key, config.enabledPublicKey)
  assertDoesNotExposeSecrets(body)
})

test('get-payment-config returns disabled config without keys for a disabled store', async () => {
  const response = await postGetPaymentConfig(config.disabledStoreId)

  assert.equal(response.status, 200)

  const body = await readJson(response)

  assert.equal(body.store_id, config.disabledStoreId)
  assert.equal(body.provider, 'culqi')
  assert.equal(body.environment, 'test')
  assert.equal(body.currency, 'PEN')
  assert.equal(body.enabled, false)
  assert.equal(body.culqi_public_key, null)
  assertDoesNotExposeSecrets(body)
})

test('get-payment-config returns disabled config for a missing store', async () => {
  const response = await postGetPaymentConfig(config.missingStoreId)

  assert.equal(response.status, 200)

  const body = await readJson(response)

  assert.equal(body.store_id, config.missingStoreId)
  assert.equal(body.provider, 'culqi')
  assert.equal(body.environment, 'test')
  assert.equal(body.currency, 'PEN')
  assert.equal(body.enabled, false)
  assert.equal(body.culqi_public_key, null)
  assertDoesNotExposeSecrets(body)
})

async function postGetPaymentConfig(storeId) {
  const response = await fetch(config.functionUrl, {
    body: JSON.stringify({ store_id: storeId }),
    headers: {
      'Content-Type': 'application/json',
      Origin: config.origin,
    },
    method: 'POST',
  })

  if (response.status === 401) {
    throw new Error(
      'get-payment-config devolvio 401. Revisa supabase/config.toml: [functions.get-payment-config] verify_jwt = false.',
    )
  }

  if (response.status === 403) {
    throw new Error(
      `get-payment-config devolvio 403. Revisa GET_PAYMENT_CONFIG_ALLOWED_ORIGINS e incluye ${config.origin}.`,
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

function assertDoesNotExposeSecrets(body) {
  const serialized = JSON.stringify(body)

  assert.equal('culqi_private_key' in body, false)
  assert.equal('culqi_private_key_secret_id' in body, false)
  assert.equal('culqi_webhook_secret_id' in body, false)
  assert.equal('has_culqi_private_key' in body, false)
  assert.equal('has_culqi_webhook_secret' in body, false)
  assert.doesNotMatch(serialized, /sk_test_/)
}

function readRequiredEnv(name) {
  const value = process.env[name]

  if (!value) {
    throw new Error(`${name} debe estar definido.`)
  }

  return value
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
