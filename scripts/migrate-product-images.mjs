#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { slugifyPathSegment } from './lib/path-slugs.mjs'

const PRODUCT_IMAGES_BUCKET = 'product-images'
const STORE_ID = 1
const STORE_SLUG = 'veterinaria-kafka'
const LEGACY_PATH_PATTERN = /^1\/(\d+)\/image\.webp$/

const options = parseArgs(process.argv.slice(2))
const mode = options.mode ?? 'dry-run'
const onlyProductId = options.productId ? Number(options.productId) : null
const backupDir = options.backupDir ?? 'migration-backups'

if (!['dry-run', 'execute'].includes(mode)) {
  fail('Usa --mode dry-run o --mode execute.')
}

if (onlyProductId !== null && (!Number.isInteger(onlyProductId) || onlyProductId <= 0)) {
  fail('--product-id debe ser un entero positivo.')
}

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  fail(
    'Faltan SUPABASE_URL/VITE_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno. No los guardes en el repo.',
  )
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
  },
})

const analyzedRows = options.csv
  ? await readAnalyzedCsv(options.csv)
  : await fetchLegacyRowsFromSupabase()
const filteredRows = analyzedRows.filter((row) =>
  onlyProductId === null ? true : row.id === onlyProductId,
)

if (filteredRows.length === 0) {
  console.log('No hay productos para migrar con los filtros indicados.')
  process.exit(0)
}

await mkdir(backupDir, { recursive: true })
const backupPath = path.join(
  backupDir,
  `product-image-paths-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
)
const backupLines = filteredRows.map((row) =>
  JSON.stringify({
    product_id: row.id,
    store_id: row.store_id,
    name: row.name,
    original_image_path: row.image_path,
  }),
)
await writeFile(backupPath, `${backupLines.join('\n')}\n`, 'utf8')

console.log(`Modo: ${mode}`)
console.log(`Productos considerados: ${filteredRows.length}`)
console.log(`Backup local: ${backupPath}`)

const results = []

for (const analyzedRow of filteredRows) {
  const result = await migrateOne(analyzedRow)
  results.push(result)
  console.log(
    `${result.status.toUpperCase()} product=${analyzedRow.id} ${result.message}`,
  )
}

const summary = results.reduce(
  (counts, result) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1
    return counts
  },
  {},
)

console.log('Resumen:', summary)

async function migrateOne(analyzedRow) {
  const legacyMatch = analyzedRow.image_path.match(LEGACY_PATH_PATTERN)
  if (!legacyMatch) {
    return {
      status: 'skipped',
      message: `ruta no coincide con formato legacy: ${analyzedRow.image_path}`,
    }
  }

  const currentProduct = await fetchProduct(analyzedRow.id)
  if (!currentProduct) {
    return { status: 'skipped', message: 'producto no existe actualmente' }
  }

  if (currentProduct.store_id !== STORE_ID) {
    return {
      status: 'skipped',
      message: `store_id actual ${currentProduct.store_id} no es ${STORE_ID}`,
    }
  }

  if (currentProduct.image_path !== analyzedRow.image_path) {
    return {
      status: 'skipped',
      message: `image_path cambio desde el analisis: ${currentProduct.image_path ?? 'NULL'}`,
    }
  }

  const expectedLegacyProductId = Number(legacyMatch[1])
  if (expectedLegacyProductId !== currentProduct.id) {
    return {
      status: 'skipped',
      message: `ruta legacy apunta a producto ${expectedLegacyProductId}`,
    }
  }

  const destinationPath = buildDestinationPath(currentProduct)
  if (currentProduct.image_path === destinationPath) {
    return { status: 'skipped', message: 'ya apunta a la ruta nueva' }
  }

  const destinationExists = await objectExists(destinationPath)
  if (destinationExists) {
    return {
      status: 'skipped',
      message: `destino ya existe, no se sobrescribe: ${destinationPath}`,
    }
  }

  const sourceBlob = await downloadObject(currentProduct.image_path)
  const sourceBytes = await blobToUint8Array(sourceBlob)

  if (mode === 'dry-run') {
    return {
      status: 'planned',
      message: `${currentProduct.image_path} -> ${destinationPath} (${sourceBytes.byteLength} bytes)`,
    }
  }

  await uploadObject(destinationPath, sourceBytes, sourceBlob.type || 'image/webp')
  const copiedBlob = await downloadObject(destinationPath)
  const copiedBytes = await blobToUint8Array(copiedBlob)

  if (copiedBytes.byteLength !== sourceBytes.byteLength) {
    return {
      status: 'error',
      message: `copia no verificada: origen ${sourceBytes.byteLength} bytes, destino ${copiedBytes.byteLength} bytes`,
    }
  }

  const { data, error } = await supabase
    .from('products')
    .update({ image_path: destinationPath })
    .eq('id', currentProduct.id)
    .eq('store_id', STORE_ID)
    .eq('image_path', analyzedRow.image_path)
    .select('id, image_path')
    .single()

  if (error) {
    return { status: 'error', message: `no se pudo actualizar DB: ${error.message}` }
  }

  return {
    status: 'migrated',
    message: `${analyzedRow.image_path} -> ${data.image_path}`,
  }
}

function buildDestinationPath(product) {
  return [
    `${STORE_ID}-${slugifyPathSegment(STORE_SLUG)}`,
    'products',
    `${product.id}-${slugifyPathSegment(product.name)}`,
    'principal-migrated.webp',
  ].join('/')
}

async function fetchProduct(productId) {
  const { data, error } = await supabase
    .from('products')
    .select('id, store_id, name, image_path')
    .eq('id', productId)
    .maybeSingle()

  if (error) {
    throw new Error(`No se pudo leer producto ${productId}: ${error.message}`)
  }

  return data
}

async function fetchLegacyRowsFromSupabase() {
  const { data, error } = await supabase
    .from('products')
    .select('id, store_id, name, image_path')
    .eq('store_id', STORE_ID)
    .not('image_path', 'is', null)

  if (error) {
    throw new Error(`No se pudo consultar products: ${error.message}`)
  }

  return normalizeRows(data ?? []).filter((row) =>
    LEGACY_PATH_PATTERN.test(row.image_path),
  )
}

async function readAnalyzedCsv(csvPath) {
  const contents = await readFile(csvPath, 'utf8')
  const rows = parseCsv(contents)
  return normalizeRows(rows)
}

function normalizeRows(rows) {
  return rows.map((row) => {
    const id = Number(row.id ?? row.product_id)
    const storeId = Number(row.store_id)
    const name = String(row.name ?? '')
    const imagePath = String(row.image_path ?? '')

    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`CSV invalido: id/product_id no valido en ${JSON.stringify(row)}`)
    }

    if (storeId !== STORE_ID) {
      throw new Error(`CSV invalido: store_id debe ser ${STORE_ID} en producto ${id}`)
    }

    if (!name) {
      throw new Error(`CSV invalido: name vacio en producto ${id}`)
    }

    if (!imagePath) {
      throw new Error(`CSV invalido: image_path vacio en producto ${id}`)
    }

    return {
      id,
      store_id: storeId,
      name,
      image_path: imagePath,
    }
  })
}

async function objectExists(objectPath) {
  const { data, error } = await supabase
    .storage
    .from(PRODUCT_IMAGES_BUCKET)
    .download(objectPath)

  if (!error && data) {
    return true
  }

  if (error?.message?.toLowerCase().includes('not found')) {
    return false
  }

  if (error?.statusCode === '404') {
    return false
  }

  return false
}

async function downloadObject(objectPath) {
  const { data, error } = await supabase
    .storage
    .from(PRODUCT_IMAGES_BUCKET)
    .download(objectPath)

  if (error || !data) {
    throw new Error(`No se pudo descargar ${objectPath}: ${error?.message ?? 'sin datos'}`)
  }

  return data
}

async function uploadObject(objectPath, bytes, contentType) {
  const { error } = await supabase
    .storage
    .from(PRODUCT_IMAGES_BUCKET)
    .upload(objectPath, bytes, {
      cacheControl: '3600',
      contentType,
      upsert: false,
    })

  if (error) {
    throw new Error(`No se pudo subir ${objectPath}: ${error.message}`)
  }
}

async function blobToUint8Array(blob) {
  return new Uint8Array(await blob.arrayBuffer())
}

function parseArgs(args) {
  const parsed = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) {
      fail(`Argumento no reconocido: ${arg}`)
    }

    const key = arg.slice(2)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      fail(`Falta valor para --${key}`)
    }

    parsed[toCamelCase(key)] = value
    index += 1
  }

  return parsed
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
}

function parseCsv(contents) {
  const [headerLine, ...lines] = contents.trim().split(/\r?\n/)
  const headers = parseCsvLine(headerLine)

  return lines
    .filter((line) => line.trim())
    .map((line) => {
      const values = parseCsvLine(line)
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
    })
}

function parseCsvLine(line) {
  const values = []
  let current = ''
  let inQuotes = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    const nextCharacter = line[index + 1]

    if (character === '"' && inQuotes && nextCharacter === '"') {
      current += '"'
      index += 1
      continue
    }

    if (character === '"') {
      inQuotes = !inQuotes
      continue
    }

    if (character === ',' && !inQuotes) {
      values.push(current)
      current = ''
      continue
    }

    current += character
  }

  values.push(current)
  return values
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
