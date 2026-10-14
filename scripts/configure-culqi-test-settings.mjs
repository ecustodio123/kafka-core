#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { readFile } from 'node:fs/promises'

const options = parseArgs(process.argv.slice(2))

if (options.envFile) {
  await loadEnvFile(options.envFile)
}

const storeId = readSafeInteger('STORE_ID', process.env.STORE_ID ?? options.storeId)
const supabaseUrl = readRequiredEnv('SUPABASE_URL', [
  process.env.SUPABASE_URL,
  process.env.VITE_SUPABASE_URL,
])
const supabasePublishableKey = readRequiredEnv('SUPABASE_PUBLISHABLE_KEY', [
  process.env.SUPABASE_PUBLISHABLE_KEY,
  process.env.SUPABASE_ANON_KEY,
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
])
const authJwt = readRequiredEnv('SUPABASE_AUTH_JWT', [process.env.SUPABASE_AUTH_JWT])
const culqiPublicKey = readRequiredEnv('CULQI_TEST_PUBLIC_KEY', [
  process.env.CULQI_TEST_PUBLIC_KEY,
])
const culqiPrivateKey = readRequiredEnv('CULQI_TEST_PRIVATE_KEY', [
  process.env.CULQI_TEST_PRIVATE_KEY,
])
const culqiWebhookSecret = normalizeOptionalSecret(process.env.CULQI_TEST_WEBHOOK_SECRET)
const enablePayments = readBooleanEnv(process.env.CULQI_TEST_ENABLE_PAYMENTS ?? 'true')

if (!/^pk_test_[A-Za-z0-9]+$/.test(culqiPublicKey)) {
  fail('CULQI_TEST_PUBLIC_KEY debe empezar con pk_test_ y contener solo caracteres alfanumericos.')
}

if (!/^sk_test_[A-Za-z0-9]+$/.test(culqiPrivateKey)) {
  fail('CULQI_TEST_PRIVATE_KEY debe empezar con sk_test_ y contener solo caracteres alfanumericos.')
}

if (culqiWebhookSecret && culqiWebhookSecret.length < 12) {
  fail('CULQI_TEST_WEBHOOK_SECRET debe tener al menos 12 caracteres si se define.')
}

if (!looksLikeJwt(authJwt)) {
  fail('SUPABASE_AUTH_JWT no parece un JWT valido de Supabase Auth.')
}

const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  global: {
    headers: {
      Authorization: `Bearer ${authJwt}`,
      'X-Client-Info': 'kafka-admin-configure-culqi-test-settings',
    },
  },
})

const { data, error } = await supabase.rpc('upsert_store_culqi_test_settings', {
  requested_store_id: storeId,
  culqi_public_key: culqiPublicKey,
  culqi_private_key: culqiPrivateKey,
  culqi_webhook_secret: culqiWebhookSecret,
  enable_payments: enablePayments,
})

if (error) {
  fail(`No se pudo configurar Culqi TEST: ${sanitizeError(error.message)}`)
}

const result = Array.isArray(data) ? data[0] : data

if (!result) {
  fail('El RPC no devolvio confirmacion de configuracion.')
}

console.log('Configuracion Culqi TEST actualizada.')
console.log(`store_id=${result.store_id}`)
console.log(`environment=${result.environment}`)
console.log(`active=${result.active}`)
console.log(`culqi_enabled=${result.culqi_enabled}`)
console.log(`currency=${result.currency}`)
console.log(`has_culqi_private_key=${result.has_culqi_private_key}`)
console.log(`has_culqi_webhook_secret=${result.has_culqi_webhook_secret}`)

function parseArgs(args) {
  const parsed = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--env-file') {
      parsed.envFile = args[index + 1]
      index += 1
      continue
    }

    if (arg === '--store-id') {
      parsed.storeId = args[index + 1]
      index += 1
      continue
    }

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }

    fail(`Argumento no reconocido: ${arg}`)
  }

  return parsed
}

async function loadEnvFile(path) {
  if (!path) {
    fail('Debes indicar una ruta despues de --env-file.')
  }

  const content = await readFile(path, 'utf8')

  for (const [lineNumber, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) {
      fail(`Linea invalida en ${path}:${lineNumber + 1}`)
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = unquoteEnvValue(trimmed.slice(separatorIndex + 1).trim())

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      fail(`Variable invalida en ${path}:${lineNumber + 1}`)
    }

    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}

function readRequiredEnv(name, values) {
  const value = values.find((candidate) => candidate?.trim())

  if (!value) {
    fail(`${name} debe estar definido en el entorno local o archivo --env-file.`)
  }

  return value.trim()
}

function readSafeInteger(name, value) {
  if (!value || !/^[1-9][0-9]*$/.test(String(value).trim())) {
    fail(`${name} debe ser un entero positivo.`)
  }

  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed)) {
    fail(`${name} excede Number.MAX_SAFE_INTEGER.`)
  }

  return parsed
}

function readBooleanEnv(value) {
  if (value === 'true') {
    return true
  }

  if (value === 'false') {
    return false
  }

  fail('CULQI_TEST_ENABLE_PAYMENTS debe ser true o false.')
}

function normalizeOptionalSecret(value) {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function looksLikeJwt(value) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
}

function sanitizeError(message) {
  return message
    .replace(/sk_test_[A-Za-z0-9]+/g, '[redacted_private_key]')
    .replace(/pk_test_[A-Za-z0-9]+/g, '[redacted_public_key]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted_jwt]')
}

function printHelp() {
  console.log(`Uso:
  node scripts/configure-culqi-test-settings.mjs --env-file .env.culqi-test.local

Variables requeridas:
  STORE_ID
  SUPABASE_URL o VITE_SUPABASE_URL
  SUPABASE_PUBLISHABLE_KEY, SUPABASE_ANON_KEY o VITE_SUPABASE_PUBLISHABLE_KEY
  SUPABASE_AUTH_JWT
  CULQI_TEST_PUBLIC_KEY
  CULQI_TEST_PRIVATE_KEY

Variables opcionales:
  CULQI_TEST_WEBHOOK_SECRET
  CULQI_TEST_ENABLE_PAYMENTS=true|false

No pases llaves ni JWT como argumentos de CLI.`)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
