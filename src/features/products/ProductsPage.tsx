import { RecoveryBoundary } from '../../components/RecoveryBoundary'
import { productBrowserStorage } from '../../services/productBrowserStorage'
import { productAbortController } from '../../services/productCompatibility'
import { imageDiagnostics } from '../../services/imageDiagnostics'
import { Toggle } from '../../components/Toggle'
import { cleanupCatalogImages, reportCatalogCleanup, deleteCatalogEntity } from '../../services/catalogDeletion'
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
  Trash2,
  X,
} from 'lucide-react'
import {
  getProductImageUrl,
  productImageCoordinator,
} from '../../services/productImages'
import { prepareProductImage, type PreparedProductImage } from '../../services/productImagePreparation'
import type { ProductImageOperation } from '../../services/productImageOperation'
import { listCategories } from '../../services/categories'
import {
  createProduct,
  getProducts,
  setProductAvailability,
  updateProduct,
  type ProductFormInput,
} from '../../services/products'
import type { Category, Product, Store } from '../../types/database'
import { createProductCreationCoordinator } from '../../services/productCreation'
import { parseProductForm, productFormFromProduct, type ProductFormState as FormState } from './productForm'
import { productDrafts, sameDraftForm, type ProductDraft } from './productDraft'

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
const imagePhaseLabels = {
  prepared: 'Preparada', uploading: 'Subiendo', uploaded: 'Subida confirmada', linking: 'Vinculando',
  linked: 'Vinculada', uncertain: 'Verificacion pendiente', conflict: 'Conflicto',
}

export function ProductsPage(props: { store: Store; userId: string; onLeave?: () => void }) {
  const diagnostics = useMemo(() => imageDiagnostics(props.userId, props.store.id), [props.userId, props.store.id])
  return <RecoveryBoundary onLeave={props.onLeave} module="products" report={(error, info) => diagnostics.incident(error, info)} key={`${props.userId}.${props.store.id}`}><ProductsEditor {...props} diagnostics={diagnostics} /></RecoveryBoundary>
}
function ProductsEditor({ store, userId, diagnostics }: { store: Store; userId: string; diagnostics: ReturnType<typeof imageDiagnostics> }) {
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [preparingImage, setPreparingImage] = useState(false)
  const [actionProductId, setActionProductId] = useState<Product['id'] | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [preparedImage, setPreparedImage] = useState<PreparedProductImage | null>(null)
  const [invalidImageSelection, setInvalidImageSelection] = useState(false)
  const [imageOperation, setImageOperation] = useState<ProductImageOperation | null>(null)
  const saveInFlight = useRef(false)
  const [browserStorage] = useState(() => productBrowserStorage())
  const [draftWarning, setDraftWarning] = useState<string | null>(null)
  const imagePreparation = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const diagnostic = useRef<ReturnType<typeof diagnostics.start> | null>(null)
  const drafts = useMemo(() => productDrafts(browserStorage.drafts, userId, store.id), [browserStorage, userId, store.id])
  function warnDraft() {
    if (browserStorage.unavailable()) setDraftWarning('No se puede guardar un borrador recuperable en este navegador. No cierres la pagina. Las operaciones que requieren recuperacion local no se enviaran.')
  }
  useEffect(() => {
    mounted.current = true
    diagnostics.recover()
    return () => { mounted.current = false; imagePreparation.current?.abort(); diagnostic.current?.stage('canceled') }
  }, [diagnostics])
  const activeDraft = useRef<ProductDraft | null>(null)
  const formValue = useRef<FormState>(emptyForm)
  const [recoverableDraft, setRecoverableDraft] = useState<ProductDraft | null>(() => {
    try { return drafts.latest() } catch { return null }
  })
  function persistDraft(nextForm = formValue.current, imagePending = activeDraft.current?.imagePending ?? false) {
    const current = activeDraft.current
    if (!current) return
    try {
      activeDraft.current = drafts.save({ ...current, form: nextForm, imagePending }, current)
      setRecoverableDraft(activeDraft.current)
      warnDraft()
    } catch {
      setDraftWarning('No se pudo guardar el borrador local o existe uno mas reciente. No cierres la pagina; reabre el formulario antes de recuperar otro borrador.')
    }
  }
  const changeForm: Dispatch<SetStateAction<FormState>> = next => {
    const value = typeof next === 'function' ? next(formValue.current) : next
    formValue.current = value
    setForm(value)
    persistDraft(value)
  }
  function clearDraft() {
    if (activeDraft.current) drafts.clear(activeDraft.current)
    activeDraft.current = null
    setRecoverableDraft(drafts.latest())
    warnDraft()
  }
  function openDraft(product: Product | null, initial: FormState) {
    const existing = drafts.load(product?.id ?? null)
    if (existing && product && existing.baseline && !sameDraftForm(existing.baseline, initial)) {
      setRecoverableDraft(existing)
      setNotice({ type: 'error', message: 'El producto cambio desde el borrador. No se reemplazaron los datos actuales. Puedes descartar el borrador recuperable.' })
      return false
    }
    activeDraft.current = existing ?? drafts.save({ productId: product?.id ?? null,
      form: initial, baseline: product ? initial : null, imagePending: false }, null)
    warnDraft()
    formValue.current = { ...activeDraft.current.form }
    setForm(formValue.current)
    setNotice(existing ? { type: 'success', message: existing.imagePending
      ? 'Borrador recuperado. Selecciona nuevamente la imagen pendiente; el archivo no se guarda en el borrador.'
      : 'Borrador recuperado.' } : null)
    return true
  }
  const confirmedSave = useRef<{
    storeId: number; ownerId: Store['owner_user_id']; productId: number; input: ProductFormInput
  } | null>(null)
  const images = useMemo(() => productImageCoordinator(
    store.owner_user_id ?? 'unassigned', store.id, operation => {
      if (mounted.current) setImageOperation(operation)
      const stage = { uploading: 'upload_started', uploaded: 'upload_completed', linked: 'associated', uncertain: 'failed', conflict: 'failed' } as const
      if (operation.phase in stage) diagnostic.current?.stage(stage[operation.phase as keyof typeof stage])
    },
  ), [store.id, store.owner_user_id])
  const creation = useMemo(() => createProductCreationCoordinator(
    store.owner_user_id ?? 'unassigned', store.id,
    browserStorage.durable,
    (operationId, input) => createProduct(store.id, operationId, input),
  ), [store.id, store.owner_user_id, browserStorage])

  const loadProducts = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const [nextProducts, nextCategories] = await Promise.all([
        getProducts(store.id),
        listCategories(store.id),
      ])
      if (mounted.current) { setProducts(nextProducts); setCategories(nextCategories) }
    } catch (caughtError) {
      if (mounted.current) setError(getErrorMessage(caughtError))
    } finally {
      if (mounted.current) setLoading(false)
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
      let recovered: Product | null = null
      try { recovered = await creation.recover() } catch (error) {
        if (!browserStorage.unavailable()) throw error
        warnDraft()
      }
      if (recovered) {
        replaceProduct(recovered)
        openEditForm(recovered, true)
        setNotice({ type: 'success', message: 'Producto recuperado. Puedes continuar editandolo.' })
        return
      }
      if (!openDraft(null, emptyForm)) return
      setEditingProduct(null)
      confirmedSave.current = null
      setImageFile(null)
      setPreparedImage(null)
      setInvalidImageSelection(false)
      setImageOperation(null)
      setIsFormOpen(true)
    } catch (caughtError) {
      setNotice({ type: 'error', message: getErrorMessage(caughtError) })
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }

  function openEditForm(product: Product, recovering = false) {
    if (saveInFlight.current && !recovering) return
    try {
      try { setImageOperation(images.load(product.id)) } catch (error) {
        // An unavailable receipt store must not crash or prevent editing fields. Writes still fail closed.
        try { browserStorage.durable.getItem('kafka.storage-check') } catch { warnDraft() }
        if (!browserStorage.unavailable()) throw error
        setImageOperation(null)
      }
    } catch (caughtError) {
      setNotice({ type: 'error', message: getErrorMessage(caughtError) })
      return
    }
    const nextForm = productFormFromProduct(product)
    try { if (!openDraft(product, nextForm)) return } catch {
      setNotice({ type: 'error', message: 'No se pudo abrir el borrador local. Revisa el almacenamiento del navegador.' })
      return
    }
    const normalized = parseProductForm(nextForm, categories, store.id)
    // Compare against the form's initial meaning, including display-only defaults.
    confirmedSave.current = 'value' in normalized ? {
      storeId: store.id, ownerId: store.owner_user_id, productId: product.id,
      input: normalized.value,
    } : null
    setEditingProduct(product)
    setImageFile(null)
    setPreparedImage(null)
    setInvalidImageSelection(false)
    setIsFormOpen(true)
  }

  function closeForm() {
    if (imagePreparation.current) {
      imagePreparation.current.abort(); imagePreparation.current = null
      diagnostic.current?.stage('canceled'); saveInFlight.current = false; setSaving(false); setPreparingImage(false)
    }
    if (saveInFlight.current) {
      return
    }

    try { clearDraft() } catch {
      setNotice({ type: 'error', message: 'No se pudo descartar el borrador local.' })
      return
    }
    setIsFormOpen(false)
    confirmedSave.current = null
    setEditingProduct(null)
    setForm(emptyForm)
    setImageFile(null)
    setPreparedImage(null)
    setInvalidImageSelection(false)
    setImageOperation(null)
  }

  async function handleImageChange(file: File | null) {
    if (saveInFlight.current && !imagePreparation.current) return
    imagePreparation.current?.abort()
    diagnostic.current?.stage('canceled')
    let controller: AbortController
    try { controller = productAbortController() } catch (error) {
      imagePreparation.current = null; saveInFlight.current = false; setSaving(false); setPreparingImage(false)
      setNotice({ type: 'error', message: getErrorMessage(error) }); return
    }
    imagePreparation.current = controller
    if (!file) {
      setImageFile(null)
      setPreparedImage(null)
      setInvalidImageSelection(false)
      persistDraft(formValue.current, false)
      imagePreparation.current = null
      saveInFlight.current = false; setSaving(false); setPreparingImage(false)
      return
    }
    persistDraft(formValue.current, true)
    saveInFlight.current = true
    setSaving(true)
    setPreparingImage(true)
    try {
      const trace = diagnostics.start()
      diagnostic.current = trace
      const prepared = await prepareProductImage(file, undefined, undefined, { signal: controller.signal, stage: stage => { if (!controller.signal.aborted) trace.stage(stage) } })
      if (controller.signal.aborted || imagePreparation.current !== controller) return
      if (imageOperation && imageOperation.phase !== 'linked') {
        if (prepared.sha256 !== imageOperation.sha256 || prepared.size !== imageOperation.size) {
          throw new Error('Hay otra imagen pendiente. Reintenta o descarta ese cambio antes de seleccionar una distinta.')
        }
        prepared.selectionId = imageOperation.selectionId
      }
      setImageFile(file)
      setPreparedImage(prepared)
      setInvalidImageSelection(false)
      persistDraft(formValue.current, true)
      setNotice(null)
    } catch (caughtError) {
      if (controller.signal.aborted || imagePreparation.current !== controller) return
      diagnostic.current?.stage('failed')
      setInvalidImageSelection(true)
      setNotice({ type: 'error', message: getErrorMessage(caughtError) })
    } finally {
      if (imagePreparation.current === controller && !controller.signal.aborted) {
        imagePreparation.current = null
        setPreparingImage(false)
        saveInFlight.current = false
        setSaving(false)
      }
    }
  }

  async function retryImage() {
    if (saveInFlight.current || !editingProduct || !imageOperation) return
    saveInFlight.current = true
    setSaving(true)
    try {
      const result = await images.run(editingProduct.id, preparedImage ?? undefined)
      if (result.product) { setEditingProduct(result.product); replaceProduct(result.product) }
      if (result.status === 'linked') {
        persistDraft(formValue.current, false)
        setImageOperation(null)
        setPreparedImage(null)
        setImageFile(null)
        if (imageOperation.expectedPath) {
          try { reportCatalogCleanup(await cleanupCatalogImages(store.id, 'product', String(editingProduct.id))) }
          catch { console.warn('Catalog image cleanup could not be confirmed.') }
        }
      }
      setNotice({ type: result.status === 'linked' ? 'success' : 'error', message: result.message })
    } catch (caughtError) {
      setNotice({ type: 'error', message: getErrorMessage(caughtError) })
    } finally { saveInFlight.current = false; setSaving(false) }
  }

  function discardImage() {
    if (saveInFlight.current || !editingProduct) return
    try {
      images.discard(editingProduct.id)
      persistDraft(formValue.current, false)
      setImageOperation(null)
      setPreparedImage(null)
      setImageFile(null)
      setNotice({ type: 'success', message: 'Cambio descartado. Los archivos almacenados se conservaron.' })
    } catch (caughtError) { setNotice({ type: 'error', message: getErrorMessage(caughtError) }) }
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
    let phase: 'validation' | 'product' | 'image' = 'validation'
    try {
      setSaving(true)
      setNotice(null)

      if ((imageFile || invalidImageSelection) && !preparedImage) throw new Error('Selecciona una imagen valida o quita la seleccion antes de guardar.')
      if (activeDraft.current?.imagePending && !preparedImage && !imageOperation) {
        throw new Error('Selecciona nuevamente la imagen pendiente o usa Quitar seleccion antes de guardar.')
      }
      if (imageOperation && imageOperation.phase !== 'linked') {
        throw new Error('Hay una imagen pendiente. Usa Reintentar imagen antes de guardar otros cambios.')
      }
      const confirmed = confirmedSave.current
      const sameConfirmedInput = editingProduct && confirmed
        && confirmed.storeId === store.id && confirmed.ownerId === store.owner_user_id
        && confirmed.productId === editingProduct.id
        && (Object.keys(parsedInput.value) as (keyof ProductFormInput)[])
          .every((key) => parsedInput.value[key] === confirmed.input[key])
      phase = 'product'
      let savedProduct = sameConfirmedInput ? editingProduct : editingProduct
        ? await updateProduct(store.id, editingProduct.id, parsedInput.value)
        : await creation.create(parsedInput.value)
      if (!sameConfirmedInput) {
        confirmedSave.current = {
          storeId: store.id, ownerId: store.owner_user_id, productId: savedProduct.id,
          input: { ...parsedInput.value },
        }
      }
      // Persist the confirmed identity in UI before any later image operation.
      setEditingProduct(savedProduct)
      replaceProduct(savedProduct)
      if (activeDraft.current) {
        const previous = activeDraft.current
        try {
          activeDraft.current = drafts.save({ productId: savedProduct.id, form: formValue.current,
            baseline: productFormFromProduct(savedProduct), imagePending: previous.imagePending },
          previous.productId === savedProduct.id ? previous : null)
          if (previous.productId !== savedProduct.id) drafts.clear(previous)
          setRecoverableDraft(activeDraft.current)
        } catch {
          throw new Error('Producto guardado; no se pudo actualizar su borrador local. Conserva este formulario abierto.')
        }
      }

      if (preparedImage && imageFile) {
        phase = 'image'
        images.begin(savedProduct, store.slug, preparedImage, editingProduct?.image_path ?? null)
        const result = await images.run(savedProduct.id, preparedImage)
        if (result.product) { setEditingProduct(result.product); replaceProduct(result.product) }
        if (result.status !== 'linked' || !result.product) throw new Error(result.message)
        savedProduct = result.product
        if (editingProduct?.image_path) try {
          const cleanup = await cleanupCatalogImages(store.id, 'product', String(savedProduct.id))
          reportCatalogCleanup(cleanup)
        } catch { console.warn('Catalog image cleanup could not be confirmed.') }
      }

      replaceProduct(savedProduct)

      setNotice({
        type: 'success',
        message: wasEditing
          ? 'Producto actualizado correctamente.'
          : 'Producto creado correctamente.',
      })
      try { clearDraft() } catch { setNotice({ type: 'success', message: 'Producto guardado. No se pudo limpiar el borrador local; no vuelvas a enviarlo.' }) }
      setIsFormOpen(false)
      confirmedSave.current = null
      setEditingProduct(null)
      setForm(emptyForm)
      setImageFile(null)
      setPreparedImage(null)
      setImageOperation(null)
    } catch (caughtError) {
      setNotice({ type: 'error', message: phase === 'image'
        ? `Producto guardado; falta completar la imagen. ${getErrorMessage(caughtError)}`
        : phase === 'product'
          ? `No se pudieron guardar los datos del producto. ${getErrorMessage(caughtError)}`
          : getErrorMessage(caughtError) })
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }

  async function handleAvailabilityChange(product: Product) {
    if (saveInFlight.current) return
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

  async function handleDelete(product: Product) {
    if (saveInFlight.current || isFormOpen || actionProductId !== null) return
    if (!window.confirm(`¿Eliminar el producto "${product.name}"? Esta acción no se puede deshacer.`)) return
    saveInFlight.current = true
    setSaving(true)
    setActionProductId(product.id)
    try {
      const pending = images.load(product.id)
      if (pending && pending.phase !== 'linked') throw new Error('Hay una imagen pendiente. Resuelve o descarta ese cambio antes de eliminar.')
      const result = await deleteCatalogEntity(store.id, 'product', String(product.id))
      if (result.deleted !== true) throw new Error('No se pudo confirmar la eliminación. Actualiza la lista antes de volver a intentarlo.')
      setProducts(current => current.filter(row => row.id !== product.id))
      reportCatalogCleanup(result)
      setNotice({ type: 'success', message: 'Producto eliminado correctamente.' })
    } catch (caught) { setNotice({ type: 'error', message: getErrorMessage(caught) }) }
    finally { saveInFlight.current = false; setSaving(false); setActionProductId(null) }
  }

  async function runProductAction(
    productId: Product['id'],
    action: () => Promise<void>,
  ) {
    if (saveInFlight.current) return
    saveInFlight.current = true
    try {
      setActionProductId(productId)
      setNotice(null)
      await action()
    } catch (caughtError) {
      setNotice({ type: 'error', message: getErrorMessage(caughtError) })
    } finally {
      saveInFlight.current = false
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

      {preparingImage && <button type="button" className="mb-3 underline" onClick={() => {
        imagePreparation.current?.abort(); imagePreparation.current = null; diagnostic.current?.stage('canceled')
        saveInFlight.current = false; setSaving(false); setPreparingImage(false)
      }}>Cancelar preparacion de imagen</button>}
      {draftWarning && <p role="alert" className="mb-4 rounded border border-amber-400 bg-amber-50 p-3">{draftWarning}</p>}
      {notice ? <NoticeBanner notice={notice} /> : null}

      {!isFormOpen && recoverableDraft && <div className="mb-4 flex flex-wrap items-center gap-3" role="status">
        <span className="text-sm">Hay un borrador de producto sin guardar.</span>
        <button type="button" className="text-sm underline" disabled={loading || saving} onClick={() => {
          if (recoverableDraft.productId === null) void openCreateForm()
          else {
            const product = products.find(row => row.id === recoverableDraft.productId)
            if (product) openEditForm(product)
            else setNotice({ type: 'error', message: 'El producto del borrador no esta disponible. No se creara otro producto.' })
          }
        }}>Recuperar borrador</button>
        <button type="button" className="text-sm underline" onClick={() => {
          try { drafts.clear(recoverableDraft); setRecoverableDraft(drafts.latest()) }
          catch { setNotice({ type: 'error', message: 'No se pudo descartar el borrador.' }) }
        }}>Descartar borrador</button>
      </div>}

      {isFormOpen ? (
        <ProductForm
          form={form}
          preparingImage={preparingImage}
          isEditing={Boolean(editingProduct)}
          saving={saving}
          setForm={changeForm}
          categories={categories}
          editingProduct={editingProduct}
          imageFile={imageFile}
          imageReselectionRequired={activeDraft.current?.imagePending === true}
          imageOperation={imageOperation}
          onImageChange={(file) => void handleImageChange(file)}
          onRetryImage={() => void retryImage()}
          onDiscardImage={discardImage}
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
            onDelete={handleDelete}
            deletionDisabled={saving || isFormOpen || actionProductId !== null}
          />
        )}
      </div>
    </section>
  )
}

function ProductForm({
  form,
  preparingImage,
  isEditing,
  saving,
  setForm,
  categories,
  editingProduct,
  imageFile,
  imageReselectionRequired,
  imageOperation,
  onRetryImage,
  onDiscardImage,
  onImageChange,
  onCancel,
  onSubmit,
}: {
  form: FormState
  preparingImage: boolean
  isEditing: boolean
  saving: boolean
  setForm: Dispatch<SetStateAction<FormState>>
  categories: Category[]
  editingProduct: Product | null
  imageFile: File | null
  imageReselectionRequired: boolean
  imageOperation: ProductImageOperation | null
  onRetryImage: () => void
  onDiscardImage: () => void
  onImageChange: (file: File | null) => void
  onCancel: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const imageInput = useRef<HTMLInputElement>(null)
  const formElement = useRef<HTMLFormElement>(null)
  const editingProductId = editingProduct?.id
  useEffect(() => {
    if (editingProductId == null) return
    const element = formElement.current
    if (!element) return
    try {
      if (typeof element.scrollIntoView !== 'function') return
      const reduced = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : true
      element.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    } catch {
      try { element.scrollIntoView() } catch { /* Scrolling is optional, never block the form. */ }
    }
  }, [editingProductId])
  return (
    <form
      ref={formElement}
      className="mb-5 scroll-mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      onSubmit={onSubmit}
    >
      <fieldset className="min-w-0" disabled={saving && !preparingImage}>
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

        <div className="block">
          <label className="mb-1.5 block text-sm font-semibold text-slate-700" htmlFor="product-image">Imagen</label>
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
              aria-label="Imagen de producto"
              className="sr-only"
              id="product-image"
              ref={imageInput}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) onImageChange(file)
              }}
              type="file"
            />
            <p className="mt-2 break-all text-xs text-slate-500">
              {imageFile
                ? imageFile.name
                : 'PNG, JPG o WebP. Maximo 60 MB. Se optimiza automaticamente.'}
            </p>
            {preparingImage && <p role="status" className="mt-2 text-sm text-slate-600">Preparando imagen...</p>}
            {imageFile || imageReselectionRequired ? (
              <button
                className="mt-2 text-xs font-medium text-slate-700 underline"
                onClick={() => {
                  if (imageInput.current) imageInput.current.value = ''
                  onImageChange(null)
                }}
                type="button"
              >
                Quitar seleccion
              </button>
            ) : null}
            {imageOperation && imageOperation.phase !== 'linked' ? (
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-200 pt-3" role="status">
                <p className="text-sm text-slate-600">Imagen pendiente: {imagePhaseLabels[imageOperation.phase]}</p>
                <div className="flex shrink-0 gap-2">
                  <button disabled={saving} aria-label="Reintentar imagen" title="Reintentar imagen" className="rounded-md border border-slate-300 p-2" type="button" onClick={onRetryImage}>
                    <RefreshCw aria-hidden="true" size={16} />
                  </button>
                  <button disabled={saving} aria-label="Descartar cambio de imagen" title="Descartar cambio sin borrar archivos" className="rounded-md border border-slate-300 p-2" type="button" onClick={onDiscardImage}>
                    <X aria-hidden="true" size={16} />
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>

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
  onDelete,
  deletionDisabled,
}: {
  actionProductId: Product['id'] | null
  categories: Category[]
  products: Product[]
  onAvailabilityChange: (product: Product) => void
  onEdit: (product: Product) => void
  onDelete: (product: Product) => void
  deletionDisabled: boolean
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
                  <IconButton label="Eliminar producto" disabled={deletionDisabled} onClick={() => onDelete(product)}>
                    <Trash2 aria-hidden="true" size={16} />
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
  disabled = false,
  onClick,
}: {
  children: ReactNode
  label: string
  loading?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      aria-label={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 text-slate-700 transition hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
      disabled={loading || disabled}
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
