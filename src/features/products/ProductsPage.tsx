import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, FormEvent, ReactNode, SetStateAction } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Package,
  Pencil,
  ImagePlus,
  Plus,
  RefreshCw,
  Save,
  Star,
  Tag,
  X,
} from 'lucide-react'
import {
  getProductImageUrl,
  uploadProductImage,
} from '../../services/productImages'
import { listCategories } from '../../services/categories'
import {
  createProduct,
  getProducts,
  setProductAvailability,
  setProductImagePath,
  updateProduct,
} from '../../services/products'
import type { Category, Product, Store } from '../../types/database'
import { createProductCreationCoordinator } from '../../services/productCreation'
import { parseProductForm, type ProductFormState as FormState } from './productForm'

type Notice = {
  type: 'success' | 'error'
  message: string
}

const emptyForm: FormState = {
  name: '',
  description: '',
  price: '',
  discount_active: false,
  discount_price: '',
  visual_rating: '5',
  category_id: '',
  available: true,
}

const currencyFormatter = new Intl.NumberFormat('es-PE', {
  style: 'currency',
  currency: 'PEN',
})

export function ProductsPage({ store }: { store: Store }) {
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [actionProductId, setActionProductId] = useState<Product['id'] | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const saveInFlight = useRef(false)
  const creation = useMemo(() => createProductCreationCoordinator(
    store.owner_user_id ?? 'unassigned', store.id,
    {
      getItem: (key) => sessionStorage.getItem(key),
      setItem: (key, value) => sessionStorage.setItem(key, value),
      removeItem: (key) => sessionStorage.removeItem(key),
    },
    (operationId, input) => createProduct(store.id, operationId, input),
  ), [store.id, store.owner_user_id])

  const loadProducts = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const [nextProducts, nextCategories] = await Promise.all([
        getProducts(store.id),
        listCategories(store.id),
      ])
      setProducts(nextProducts)
      setCategories(nextCategories)
    } catch (caughtError) {
      setError(getErrorMessage(caughtError))
    } finally {
      setLoading(false)
    }
  }, [store.id])

  // The product list is synchronized with Supabase whenever the authenticated
  // user's store changes.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void loadProducts()
  }, [loadProducts])

  const availableCount = useMemo(
    () => products.filter((product) => product.available).length,
    [products],
  )

  const offerCount = useMemo(
    () => products.filter((product) => hasActiveDiscount(product)).length,
    [products],
  )

  async function openCreateForm() {
    if (saveInFlight.current) return
    saveInFlight.current = true
    setSaving(true)
    try {
      const recovered = await creation.recover()
      if (recovered) {
        replaceProduct(recovered)
        openEditForm(recovered, true)
        setNotice({ type: 'success', message: 'Producto recuperado. Puedes continuar editandolo.' })
        return
      }
      setEditingProduct(null)
      setForm(emptyForm)
      setImageFile(null)
      setIsFormOpen(true)
      setNotice(null)
    } catch (caughtError) {
      setNotice({ type: 'error', message: getErrorMessage(caughtError) })
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }

  function openEditForm(product: Product, recovering = false) {
    if (saveInFlight.current && !recovering) return
    setEditingProduct(product)
    setForm({
      name: product.name,
      description: product.description ?? '',
      price: String(product.price),
      discount_active: product.discount_active,
      discount_price: product.discount_price === null
        ? ''
        : String(product.discount_price),
      visual_rating: product.visual_rating === null
        ? '5'
        : String(product.visual_rating),
      category_id: product.category_id ?? '',
      available: product.available,
    })
    setImageFile(null)
    setIsFormOpen(true)
    setNotice(null)
  }

  function closeForm() {
    if (saveInFlight.current) {
      return
    }

    setIsFormOpen(false)
    setEditingProduct(null)
    setForm(emptyForm)
    setImageFile(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saveInFlight.current) return

    const parsedInput = parseProductForm(form, categories, store.id)
    if ('error' in parsedInput) {
      setNotice({ type: 'error', message: parsedInput.error })
      return
    }

    saveInFlight.current = true
    const wasEditing = Boolean(editingProduct)
    let productSaved = false
    try {
      setSaving(true)
      setNotice(null)

      let savedProduct = editingProduct
        ? await updateProduct(store.id, editingProduct.id, parsedInput.value)
        : await creation.create(parsedInput.value)
      productSaved = true
      // Persist the confirmed identity in UI before any later image operation.
      setEditingProduct(savedProduct)
      replaceProduct(savedProduct)

      if (imageFile) {
        const imagePath = await uploadProductImage({
          file: imageFile,
          productName: savedProduct.name,
          productId: savedProduct.id,
          storeSlug: store.slug,
          storeId: store.id,
        })
        savedProduct = await setProductImagePath(
          store.id,
          savedProduct.id,
          imagePath,
        )
      }

      replaceProduct(savedProduct)

      setNotice({
        type: 'success',
        message: wasEditing
          ? 'Producto actualizado correctamente.'
          : 'Producto creado correctamente.',
      })
      setIsFormOpen(false)
      setEditingProduct(null)
      setForm(emptyForm)
      setImageFile(null)
    } catch (caughtError) {
      setNotice({ type: 'error', message: productSaved
        ? `Producto guardado; falta completar la imagen. ${getErrorMessage(caughtError)}`
        : getErrorMessage(caughtError) })
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }

  async function handleAvailabilityChange(product: Product) {
    await runProductAction(product.id, async () => {
      const updatedProduct = await setProductAvailability(
        store.id,
        product.id,
        !product.available,
      )
      replaceProduct(updatedProduct)
      setNotice({
        type: 'success',
        message: updatedProduct.available
          ? 'Producto marcado como disponible.'
          : 'Producto marcado como agotado.',
      })
    })
  }

  async function runProductAction(
    productId: Product['id'],
    action: () => Promise<void>,
  ) {
    try {
      setActionProductId(productId)
      setNotice(null)
      await action()
    } catch (caughtError) {
      setNotice({ type: 'error', message: getErrorMessage(caughtError) })
    } finally {
      setActionProductId(null)
    }
  }

  function replaceProduct(updatedProduct: Product) {
    setProducts((currentProducts) =>
      currentProducts.some((product) => product.id === updatedProduct.id)
        ? currentProducts.map((product) =>
            product.id === updatedProduct.id ? updatedProduct : product,
          )
        : [updatedProduct, ...currentProducts],
    )
  }

  return (
    <section id="productos" className="mx-auto max-w-7xl">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">Modulo activo</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">
            Productos
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Gestiona el catalogo de {store.name}. La tienda se resuelve desde
            Supabase Auth.
          </p>
        </div>

        <button
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          disabled={saving}
          onClick={() => void openCreateForm()}
          type="button"
        >
          <Plus aria-hidden="true" size={18} />
          Nuevo producto
        </button>
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Productos" value={products.length} />
        <Metric label="Disponibles" value={availableCount} />
        <Metric label="En oferta" value={offerCount} />
      </div>

      {notice ? <NoticeBanner notice={notice} /> : null}

      {isFormOpen ? (
        <ProductForm
          form={form}
          isEditing={Boolean(editingProduct)}
          saving={saving}
          setForm={setForm}
          categories={categories}
          editingProduct={editingProduct}
          imageFile={imageFile}
          onImageChange={setImageFile}
          onCancel={closeForm}
          onSubmit={handleSubmit}
        />
      ) : null}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-950">
              Lista de productos
            </h3>
            <p className="text-sm text-slate-500">
              Filtrados por la tienda asociada a tu usuario.
            </p>
          </div>
          <button
            className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loading}
            onClick={() => void loadProducts()}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} />
            Actualizar
          </button>
        </div>

        {loading ? (
          <StatePanel
            icon={<Loader2 className="animate-spin" aria-hidden="true" />}
            title="Cargando productos"
            text="Estamos consultando Supabase."
          />
        ) : error ? (
          <StatePanel
            icon={<AlertCircle aria-hidden="true" />}
            title="No se pudo cargar la lista"
            text={error}
          />
        ) : products.length === 0 ? (
          <StatePanel
            icon={<Package aria-hidden="true" />}
            title="Aun no hay productos"
            text="Crea el primer producto para esta tienda desde el boton Nuevo producto."
          />
        ) : (
          <ProductTable
            actionProductId={actionProductId}
            categories={categories}
            products={products}
            onAvailabilityChange={handleAvailabilityChange}
            onEdit={(product) => openEditForm(product)}
          />
        )}
      </div>
    </section>
  )
}

function ProductForm({
  form,
  isEditing,
  saving,
  setForm,
  categories,
  editingProduct,
  imageFile,
  onImageChange,
  onCancel,
  onSubmit,
}: {
  form: FormState
  isEditing: boolean
  saving: boolean
  setForm: Dispatch<SetStateAction<FormState>>
  categories: Category[]
  editingProduct: Product | null
  imageFile: File | null
  onImageChange: (file: File | null) => void
  onCancel: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <form
      className="mb-5 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      onSubmit={onSubmit}
    >
      <fieldset className="min-w-0" disabled={saving}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-950">
            {isEditing ? 'Editar producto' : 'Nuevo producto'}
          </h3>
          <p className="text-sm text-slate-500">
            El producto se asociara automaticamente a tu tienda.
          </p>
        </div>
        <button
          aria-label="Cerrar formulario"
          className="rounded-md p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
          onClick={onCancel}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_180px]">
        <Field label="Nombre" htmlFor="product-name">
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            id="product-name"
            maxLength={120}
            onChange={(event) =>
              setForm((current) => ({ ...current, name: event.target.value }))
            }
            placeholder="Royal Canin Adult"
            value={form.name}
          />
        </Field>

        <Field label="Precio" htmlFor="product-price">
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            id="product-price"
            min="0"
            onChange={(event) =>
              setForm((current) => ({ ...current, price: event.target.value }))
            }
            placeholder="120.00"
            step="0.01"
            type="number"
            value={form.price}
          />
        </Field>

        <Field label="Descripcion" htmlFor="product-description">
          <textarea
            className="min-h-24 w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            id="product-description"
            maxLength={500}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                description: event.target.value,
              }))
            }
            placeholder="Descripcion breve para el catalogo publico."
            value={form.description}
          />
        </Field>

        <Field label="Categoria" htmlFor="product-category">
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            id="product-category"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                category_id: event.target.value,
              }))
            }
            value={form.category_id}
          >
            <option value="">Sin categoria</option>
            {getSelectableCategories(categories, editingProduct).map(
              (category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                  {category.active ? '' : ' (inactiva)'}
                </option>
              ),
            )}
          </select>
        </Field>

        <DiscountFields form={form} setForm={setForm} />

        <Field label="Imagen" htmlFor="product-image">
          <div className="rounded-md border border-dashed border-slate-300 px-3 py-3">
            <label
              className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              htmlFor="product-image"
            >
              <ImagePlus aria-hidden="true" size={16} />
              Seleccionar imagen
            </label>
            <input
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              id="product-image"
              onChange={(event) =>
                onImageChange(event.target.files?.[0] ?? null)
              }
              type="file"
            />
            <p className="mt-2 text-xs text-slate-500">
              {imageFile
                ? imageFile.name
                : 'PNG, JPG o WebP. Se guardara como image.webp.'}
            </p>
            {imageFile ? (
              <button
                className="mt-2 text-xs font-medium text-slate-700 underline"
                onClick={() => onImageChange(null)}
                type="button"
              >
                Quitar seleccion
              </button>
            ) : null}
          </div>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <Field label="Calificacion visual" htmlFor="product-rating">
            <div className="rounded-md border border-slate-300 px-3 py-2">
              <div className="flex items-center gap-2">
                <Star
                  aria-hidden="true"
                  className="fill-amber-400 text-amber-400"
                  size={17}
                />
                <input
                  className="w-full text-sm outline-none"
                  id="product-rating"
                  max="5"
                  min="0"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      visual_rating: event.target.value,
                    }))
                  }
                  step="0.1"
                  type="number"
                  value={form.visual_rating}
                />
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Valor administrado por el negocio, de 0 a 5.
              </p>
            </div>
          </Field>
          <Toggle
            checked={form.available}
            label={form.available ? 'Disponible' : 'Agotado'}
            onChange={(available) =>
              setForm((current) => ({ ...current, available }))
            }
          />
        </div>
      </div>

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          className="inline-flex min-h-10 items-center justify-center rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          onClick={onCancel}
          type="button"
        >
          Cancelar
        </button>
        <button
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          disabled={saving}
          type="submit"
        >
          {saving ? (
            <Loader2 className="animate-spin" aria-hidden="true" size={16} />
          ) : (
            <Save aria-hidden="true" size={16} />
          )}
          Guardar
        </button>
      </div>
      </fieldset>
    </form>
  )
}

function DiscountFields({
  form,
  setForm,
}: {
  form: FormState
  setForm: Dispatch<SetStateAction<FormState>>
}) {
  const price = Number(form.price)
  const discountPrice = Number(form.discount_price)
  const canPreview =
    form.discount_active &&
    Number.isFinite(price) &&
    price > 0 &&
    Number.isFinite(discountPrice) &&
    discountPrice > 0 &&
    discountPrice < price

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3 lg:col-span-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <Tag aria-hidden="true" size={16} />
            Oferta del producto
          </div>
          <p className="mt-1 text-xs text-slate-500">
            El precio original se conserva; el precio final se calcula con la
            promocion activa.
          </p>
        </div>
        <Toggle
          checked={form.discount_active}
          label={form.discount_active ? 'Oferta activa' : 'Sin oferta'}
          onChange={(discountActive) =>
            setForm((current) => ({
              ...current,
              discount_active: discountActive,
            }))
          }
        />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-[220px_1fr]">
        <Field label="Precio promocional" htmlFor="product-discount-price">
          <input
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-100 disabled:text-slate-500"
            disabled={!form.discount_active}
            id="product-discount-price"
            min="0"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                discount_price: event.target.value,
              }))
            }
            placeholder="99.90"
            step="0.01"
            type="number"
            value={form.discount_price}
          />
        </Field>

        <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
          <p className="text-xs font-medium uppercase text-slate-500">
            Vista previa
          </p>
          {canPreview ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-400 line-through">
                {currencyFormatter.format(price)}
              </span>
              <span className="text-lg font-semibold text-slate-950">
                {currencyFormatter.format(discountPrice)}
              </span>
              <StatusPill
                tone="rose"
                text={`-${getDiscountPercent(price, discountPrice)}%`}
              />
            </div>
          ) : (
            <p className="mt-1 text-sm text-slate-500">
              {form.discount_active
                ? 'Ingresa un precio mayor que cero y menor al precio original.'
                : 'Se usara el precio original.'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function ProductTable({
  actionProductId,
  categories,
  products,
  onAvailabilityChange,
  onEdit,
}: {
  actionProductId: Product['id'] | null
  categories: Category[]
  products: Product[]
  onAvailabilityChange: (product: Product) => void
  onEdit: (product: Product) => void
}) {
  const categoryById = new Map(
    categories.map((category) => [category.id, category]),
  )

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
          <tr>
            <th className="px-4 py-3">Producto</th>
            <th className="px-4 py-3">Categoria</th>
            <th className="px-4 py-3">Precio</th>
            <th className="px-4 py-3">Calificacion</th>
            <th className="px-4 py-3">Disponibilidad</th>
            <th className="px-4 py-3 text-right">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {products.map((product) => (
            <tr key={product.id}>
              <td className="max-w-md px-4 py-4">
                <div className="flex items-center gap-3">
                  <ProductImage product={product} />
                  <div>
                    <p className="font-medium text-slate-950">{product.name}</p>
                    <p className="mt-1 line-clamp-2 text-sm text-slate-500">
                      {product.description || 'Sin descripcion'}
                    </p>
                  </div>
                </div>
              </td>
              <td className="px-4 py-4">
                <CategoryLabel category={categoryById.get(product.category_id ?? '')} />
              </td>
              <td className="whitespace-nowrap px-4 py-4">
                <ProductPrice product={product} />
              </td>
              <td className="px-4 py-4">
                <RatingStars value={product.visual_rating} />
              </td>
              <td className="px-4 py-4">
                <StatusPill
                  tone={product.available ? 'green' : 'amber'}
                  text={product.available ? 'Disponible' : 'Agotado'}
                />
              </td>
              <td className="px-4 py-4">
                <div className="flex justify-end gap-2">
                  <IconButton
                    label="Editar producto"
                    onClick={() => onEdit(product)}
                  >
                    <Pencil aria-hidden="true" size={16} />
                  </IconButton>
                  <IconButton
                    label={
                      product.available
                        ? 'Marcar como agotado'
                        : 'Marcar como disponible'
                    }
                    loading={actionProductId === product.id}
                    onClick={() => onAvailabilityChange(product)}
                  >
                    <CheckCircle2 aria-hidden="true" size={16} />
                  </IconButton>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ProductPrice({ product }: { product: Product }) {
  if (!hasActiveDiscount(product)) {
    return (
      <span className="font-medium text-slate-800">
        {currencyFormatter.format(product.price)}
      </span>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="font-semibold text-slate-950">
          {currencyFormatter.format(product.discount_price ?? product.price)}
        </span>
        <StatusPill
          tone="rose"
          text={`-${getDiscountPercent(product.price, product.discount_price ?? product.price)}%`}
        />
      </div>
      <p className="mt-1 text-xs text-slate-400 line-through">
        {currencyFormatter.format(product.price)}
      </p>
    </div>
  )
}

function RatingStars({ value }: { value: Product['visual_rating'] }) {
  const rating = clampRating(value ?? 0)

  return (
    <div className="flex items-center gap-1" aria-label={`${rating} de 5`}>
      {Array.from({ length: 5 }, (_, index) => {
        const filled = rating >= index + 0.5
        return (
          <Star
            aria-hidden="true"
            className={filled ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}
            key={index}
            size={15}
          />
        )
      })}
      <span className="ml-1 text-xs font-medium text-slate-500">
        {rating.toFixed(1)}
      </span>
    </div>
  )
}

function CategoryLabel({ category }: { category: Category | undefined }) {
  if (!category) {
    return <span className="text-sm text-slate-500">Sin categoria</span>
  }

  return (
    <span className="inline-flex min-h-7 items-center rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
      {category.name}
      {category.active ? '' : ' (inactiva)'}
    </span>
  )
}

function ProductImage({ product }: { product: Product }) {
  if (!product.image_path) {
    return (
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-400">
        <Package aria-hidden="true" size={18} />
      </div>
    )
  }

  return (
    <img
      alt=""
      className="h-12 w-12 shrink-0 rounded-md object-cover"
      src={getProductImageUrl(product.image_path)}
    />
  )
}

function Field({
  children,
  htmlFor,
  label,
}: {
  children: ReactNode
  htmlFor: string
  label: string
}) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </span>
      {children}
    </label>
  )
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700">
      {label}
      <input
        checked={checked}
        className="h-4 w-4 accent-slate-950"
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
    </label>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
    </div>
  )
}

function NoticeBanner({ notice }: { notice: Notice }) {
  const isSuccess = notice.type === 'success'

  return (
    <div
      className={`mb-5 flex items-start gap-3 rounded-md border px-4 py-3 text-sm ${
        isSuccess
          ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
          : 'border-red-200 bg-red-50 text-red-900'
      }`}
    >
      {isSuccess ? (
        <CheckCircle2 aria-hidden="true" size={18} />
      ) : (
        <AlertCircle aria-hidden="true" size={18} />
      )}
      <p>{notice.message}</p>
    </div>
  )
}

function StatePanel({
  icon,
  text,
  title,
}: {
  icon: ReactNode
  text: string
  title: string
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-4 py-12 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-md bg-slate-100 text-slate-500">
        {icon}
      </div>
      <h3 className="text-base font-semibold text-slate-950">{title}</h3>
      <p className="mt-1 max-w-lg text-sm text-slate-500">{text}</p>
    </div>
  )
}

function StatusPill({
  text,
  tone,
}: {
  text: string
  tone: 'amber' | 'blue' | 'green' | 'rose' | 'slate'
}) {
  const toneClass = {
    amber: 'bg-amber-50 text-amber-800 ring-amber-200',
    blue: 'bg-blue-50 text-blue-800 ring-blue-200',
    green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    rose: 'bg-rose-50 text-rose-700 ring-rose-200',
    slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  }[tone]

  return (
    <span
      className={`inline-flex min-h-7 items-center rounded-md px-2.5 py-1 text-xs font-semibold ring-1 ${toneClass}`}
    >
      {text}
    </span>
  )
}

function IconButton({
  children,
  label,
  loading = false,
  onClick,
}: {
  children: ReactNode
  label: string
  loading?: boolean
  onClick: () => void
}) {
  return (
    <button
      aria-label={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 text-slate-700 transition hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
      disabled={loading}
      onClick={onClick}
      title={label}
      type="button"
    >
      {loading ? (
        <Loader2 className="animate-spin" aria-hidden="true" size={16} />
      ) : (
        children
      )}
    </button>
  )
}

function hasActiveDiscount(product: Product) {
  return Boolean(
    product.discount_active &&
      product.discount_price !== null &&
      product.discount_price > 0 &&
      product.discount_price < product.price,
  )
}

function getDiscountPercent(originalPrice: number, discountPrice: number) {
  if (originalPrice <= 0 || discountPrice >= originalPrice) {
    return 0
  }

  return Math.round(((originalPrice - discountPrice) / originalPrice) * 100)
}

function clampRating(value: number) {
  return Math.min(5, Math.max(0, value))
}

function getSelectableCategories(
  categories: Category[],
  editingProduct: Product | null,
) {
  const inactiveSelectedCategory = categories.find(
    (category) => category.id === editingProduct?.category_id,
  )

  const activeCategories = categories.filter((category) => category.active)

  if (inactiveSelectedCategory && !inactiveSelectedCategory.active) {
    return [...activeCategories, inactiveSelectedCategory]
  }

  return activeCategories
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return 'Ocurrio un error inesperado.'
}
