#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { slugifyPathSegment } from './lib/path-slugs.mjs'

const CATEGORY_IMAGES_BUCKET = 'category-images'
const DEFAULT_STORE_ID = 1
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

const options = parseArgs(process.argv.slice(2))
const mode = options.mode ?? 'dry-run'
const storeId = options.storeId ? Number(options.storeId) : DEFAULT_STORE_ID
const onlyCategoryId = options.categoryId ?? null
const expectedStoreSlug = options.storeSlug ?? null
const backupDir = options.backupDir ?? 'migration-backups'

if (!['dry-run', 'execute'].includes(mode)) {
  fail('Usa --mode dry-run o --mode execute.')
}

if (!Number.isInteger(storeId) || storeId <= 0) {
  fail('--store-id debe ser un entero positivo.')
}

if (onlyCategoryId && !isUuid(onlyCategoryId)) {
  fail('--category-id debe ser un UUID valido.')
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

const store = await fetchStore(storeId)

if (!store) {
  fail(`No existe la tienda ${storeId}.`)
}

if (expectedStoreSlug && store.slug !== expectedStoreSlug) {
  fail(`La tienda ${storeId} tiene slug "${store.slug}", no "${expectedStoreSlug}".`)
}

const categories = await fetchCategories(store.id, onlyCategoryId)

if (categories.length === 0) {
  console.log('No hay categorias para migrar con los filtros indicados.')
  process.exit(0)
}

await mkdir(backupDir, { recursive: true })
const backupPath = path.join(
  backupDir,
  `category-image-urls-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
)

const backupRows = categories.map((category) => ({
  category_id: category.id,
  store_id: category.store_id,
  store_slug: store.slug,
  name: category.name,
  slug: category.slug,
  original_image_url: category.image_url,
  planned_image_url: buildPublicUrl(buildDestinationPath(store, category)),
}))

await writeFile(
  backupPath,
  `${backupRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  'utf8',
)

console.log(`Modo: ${mode}`)
console.log(`Tienda: ${store.id}-${store.slug}`)
console.log(`Categorias consideradas: ${categories.length}`)
console.log(`Backup local: ${backupPath}`)

const results = []

for (const category of categories) {
  try {
    const result = await migrateOne(store, category)
    results.push(result)
    console.log(
      `${result.status.toUpperCase()} category=${category.id} ${result.message}`,
    )
  } catch (error) {
    const result = {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }
    results.push(result)
    console.log(`${result.status.toUpperCase()} category=${category.id} ${result.message}`)
  }
}

const summary = results.reduce(
  (counts, result) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1
    return counts
  },
  {},
)

console.log('Resumen:', summary)

async function migrateOne(storeRow, analyzedCategory) {
  if (!analyzedCategory.image_url) {
    return { status: 'skipped', message: 'image_url es NULL' }
  }

  const legacyPath = extractCategoryImagePath(analyzedCategory.image_url)
  if (!legacyPath) {
    return { status: 'skipped', message: 'image_url no apunta al bucket category-images' }
  }

  const legacyMatch = legacyPath.match(
    new RegExp(`^${escapeRegExp(String(storeRow.id))}/(${UUID_PATTERN})/([^/]+)$`, 'i'),
  )

  if (!legacyMatch) {
    return {
      status: 'skipped',
      message: `ruta no coincide con formato legacy: ${legacyPath}`,
    }
  }

  const legacyCategoryId = legacyMatch[1]
  if (legacyCategoryId.toLowerCase() !== analyzedCategory.id.toLowerCase()) {
    return {
      status: 'skipped',
      message: `ruta legacy apunta a categoria ${legacyCategoryId}`,
    }
  }

  const currentCategory = await fetchCategory(analyzedCategory.id)
  if (!currentCategory) {
    return { status: 'skipped', message: 'categoria no existe actualmente' }
  }

  if (currentCategory.store_id !== storeRow.id) {
    return {
      status: 'skipped',
      message: `store_id actual ${currentCategory.store_id} no es ${storeRow.id}`,
    }
  }

  if (currentCategory.image_url !== analyzedCategory.image_url) {
    return {
      status: 'skipped',
      message: 'image_url cambio desde el inicio de la migracion',
    }
  }

  const destinationPath = buildDestinationPath(storeRow, currentCategory)
  const destinationUrl = buildPublicUrl(destinationPath)

  if (currentCategory.image_url === destinationUrl) {
    return { status: 'skipped', message: 'ya apunta a la URL nueva' }
  }

  const sourceBlob = await downloadObject(legacyPath)
  const sourceBytes = await blobToUint8Array(sourceBlob)
  const destinationState = await getDestinationState(destinationPath, sourceBytes.byteLength)

  if (destinationState.exists && !destinationState.sizeMatches) {
    return {
      status: 'failed',
      message: `destino ya existe con otro tamano, no se sobrescribe: ${destinationPath}`,
    }
  }

  if (mode === 'dry-run') {
    const action = destinationState.exists ? 'verificar y actualizar URL' : 'copiar y actualizar URL'
    return {
      status: 'planned',
      message: `${action}: ${legacyPath} -> ${destinationPath} (${sourceBytes.byteLength} bytes)`,
    }
  }

  if (!destinationState.exists) {
    await uploadObject(destinationPath, sourceBytes, sourceBlob.type || 'image/webp')
  }

  const copiedBlob = await downloadObject(destinationPath)
  const copiedBytes = await blobToUint8Array(copiedBlob)

  if (copiedBytes.byteLength !== sourceBytes.byteLength) {
    return {
      status: 'failed',
      message: `copia no verificada: origen ${sourceBytes.byteLength} bytes, destino ${copiedBytes.byteLength} bytes`,
    }
  }

  const { data, error } = await supabase
    .from('categories')
    .update({ image_url: destinationUrl })
    .eq('id', currentCategory.id)
    .eq('store_id', storeRow.id)
    .eq('image_url', analyzedCategory.image_url)
    .select('id, image_url')
    .single()

  if (error) {
    return { status: 'failed', message: `no se pudo actualizar DB: ${error.message}` }
  }

  return {
    status: 'migrated',
    message: `${legacyPath} -> ${extractCategoryImagePath(data.image_url) ?? data.image_url}`,
  }
}

function buildDestinationPath(storeRow, category) {
  return [
    `${storeRow.id}-${slugifyPathSegment(storeRow.slug)}`,
    'categories',
    `${category.id}-${slugifyPathSegment(category.slug || category.name)}`,
    'principal-migrated.webp',
  ].join('/')
}

function buildPublicUrl(objectPath) {
  const { data } = supabase
    .storage
    .from(CATEGORY_IMAGES_BUCKET)
    .getPublicUrl(objectPath)

  return data.publicUrl
}

function extractCategoryImagePath(imageUrl) {
  const marker = `/object/public/${CATEGORY_IMAGES_BUCKET}/`
  const markerIndex = imageUrl.indexOf(marker)

  if (markerIndex === -1) {
    return null
  }

  const encodedPath = imageUrl.slice(markerIndex + marker.length)
  return decodeURIComponent(encodedPath.split('?')[0] ?? '')
}

async function fetchStore(id) {
  const { data, error } = await supabase
    .from('stores')
    .select('id, name, slug')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    throw new Error(`No se pudo consultar stores: ${error.message}`)
  }

  return data
}

async function fetchCategories(currentStoreId, currentCategoryId) {
  let query = supabase
    .from('categories')
    .select('id, store_id, name, slug, image_url')
    .eq('store_id', currentStoreId)
    .not('image_url', 'is', null)

  if (currentCategoryId) {
    query = query.eq('id', currentCategoryId)
  }

  const { data, error } = await query.order('name', { ascending: true })

  if (error) {
    throw new Error(`No se pudo consultar categories: ${error.message}`)
  }

  return data ?? []
}

async function fetchCategory(categoryId) {
  const { data, error } = await supabase
    .from('categories')
    .select('id, store_id, name, slug, image_url')
    .eq('id', categoryId)
    .maybeSingle()

  if (error) {
    throw new Error(`No se pudo leer categoria ${categoryId}: ${error.message}`)
  }

  return data
}

async function getDestinationState(objectPath, expectedByteLength) {
  const { data, error } = await supabase
    .storage
    .from(CATEGORY_IMAGES_BUCKET)
    .download(objectPath)

  if (error || !data) {
    if (isNotFoundError(error)) {
      return { exists: false, sizeMatches: false }
    }

    throw new Error(
      `No se pudo verificar si existe ${objectPath}: ${error?.message ?? 'sin datos'}`,
    )
  }

  const bytes = await blobToUint8Array(data)
  return {
    exists: true,
    sizeMatches: bytes.byteLength === expectedByteLength,
  }
}

async function downloadObject(objectPath) {
  const { data, error } = await supabase
    .storage
    .from(CATEGORY_IMAGES_BUCKET)
    .download(objectPath)

  if (error || !data) {
    throw new Error(`No se pudo descargar ${objectPath}: ${error?.message ?? 'sin datos'}`)
  }

  return data
}

async function uploadObject(objectPath, bytes, contentType) {
  const { error } = await supabase
    .storage
    .from(CATEGORY_IMAGES_BUCKET)
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

function isNotFoundError(error) {
  if (!error) {
    return false
  }

  const message = error.message?.toLowerCase() ?? ''
  return error.statusCode === '404' || message.includes('not found')
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

function isUuid(value) {
  return new RegExp(`^${UUID_PATTERN}$`, 'i').test(value)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
