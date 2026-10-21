import { Toggle } from '../../components/Toggle'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  FolderTree,
  ImagePlus,
  Loader2,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Save,
  X,
} from 'lucide-react'
import {
  createCategory,
  getCategoryProductCounts,
  listCategories,
  setCategoryActive,
  setCategoryImageUrl,
  updateCategory,
  type CategoryFormInput,
  type CategoryProductCounts,
} from '../../services/categories'
import {
  deleteCategoryImageByUrl,
  uploadCategoryImage,
  validateCategoryImageFile,
} from '../../services/categoryImages'
import type { Category, Store } from '../../types/database'

type FormState = {
  name: string
  slug: string
  sort_order: string
  active: boolean
}

type Notice = {
  type: 'success' | 'error'
  message: string
}

const emptyForm: FormState = {
  name: '',
  slug: '',
  sort_order: '0',
  active: true,
}

export function CategoriesPage({ store }: { store: Store }) {
  const [categories, setCategories] = useState<Category[]>([])
  const [productCounts, setProductCounts] = useState<CategoryProductCounts>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [actionCategoryId, setActionCategoryId] = useState<
    Category['id'] | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)
  const [shouldRemoveImage, setShouldRemoveImage] = useState(false)
  const [slugTouched, setSlugTouched] = useState(false)

  const loadCategories = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const [nextCategories, nextCounts] = await Promise.all([
        listCategories(store.id),
        getCategoryProductCounts(store.id),
      ])
      setCategories(nextCategories)
      setProductCounts(nextCounts)
    } catch (caughtError) {
      setError(getErrorMessage(caughtError))
    } finally {
      setLoading(false)
    }
  }, [store.id])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void loadCategories()
  }, [loadCategories])

  const activeCount = useMemo(
    () => categories.filter((category) => category.active).length,
    [categories],
  )

  function openCreateForm() {
    setEditingCategory(null)
    setForm(emptyForm)
    resetImageState()
    setSlugTouched(false)
    setIsFormOpen(true)
    setNotice(null)
  }

  function openEditForm(category: Category) {
    setEditingCategory(category)
    setForm({
      name: category.name,
      slug: category.slug,
      sort_order: String(category.sort_order),
      active: category.active,
    })
    setImageFile(null)
    setImagePreviewUrl(category.image_url)
    setShouldRemoveImage(false)
    setSlugTouched(true)
    setIsFormOpen(true)
    setNotice(null)
  }

  function closeForm() {
    if (saving) {
      return
    }

    setIsFormOpen(false)
    setEditingCategory(null)
    setForm(emptyForm)
    resetImageState()
    setSlugTouched(false)
  }

  function handleNameChange(name: string) {
    setForm((current) => ({
      ...current,
      name,
      slug: slugTouched ? current.slug : slugify(name),
    }))
  }

  function handleSlugChange(slug: string) {
    setSlugTouched(true)
    setForm((current) => ({ ...current, slug: slugify(slug) }))
  }

  function handleImageChange(file: File | null) {
    if (!file) {
      resetImageState()
      return
    }

    try {
      validateCategoryImageFile(file)
      revokeLocalPreview()
      setImageFile(file)
      setImagePreviewUrl(URL.createObjectURL(file))
      setShouldRemoveImage(false)
      setNotice(null)
    } catch (caughtError) {
      setNotice({ type: 'error', message: getErrorMessage(caughtError) })
    }
  }

  function handleImageRemove() {
    resetImageState()
    setShouldRemoveImage(Boolean(editingCategory?.image_url))
  }

  function resetImageState() {
    revokeLocalPreview()
    setImageFile(null)
    setImagePreviewUrl(null)
    setShouldRemoveImage(false)
  }

  function revokeLocalPreview() {
    if (imagePreviewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(imagePreviewUrl)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const parsedInput = parseForm(form)
    if ('error' in parsedInput) {
      setNotice({ type: 'error', message: parsedInput.error })
      return
    }

    try {
      setSaving(true)
      setNotice(null)

      let savedCategory = editingCategory
        ? await updateCategory(store.id, editingCategory.id, parsedInput.value)
        : await createCategory(store.id, parsedInput.value)
      let cleanupWarning: string | null = null

      if (imageFile) {
        const previousImageUrl = editingCategory?.image_url ?? null
        const uploadedImage = await uploadCategoryImage({
          categoryId: savedCategory.id,
          categorySlug: savedCategory.slug,
          file: imageFile,
          storeSlug: store.slug,
          storeId: store.id,
        })

        try {
          savedCategory = await setCategoryImageUrl(
            store.id,
            savedCategory.id,
            uploadedImage.imageUrl,
          )
        } catch (caughtError) {
          await deleteCategoryImageByUrl({
            imageUrl: uploadedImage.imageUrl,
            storeId: store.id,
          })
          throw caughtError
        }

        if (previousImageUrl && previousImageUrl !== uploadedImage.imageUrl) {
          try {
            await deleteCategoryImageByUrl({
              imageUrl: previousImageUrl,
              storeId: store.id,
            })
          } catch (caughtError) {
            cleanupWarning = getErrorMessage(caughtError)
          }
        }
      } else if (shouldRemoveImage && editingCategory?.image_url) {
        savedCategory = await setCategoryImageUrl(store.id, savedCategory.id, null)

        try {
          await deleteCategoryImageByUrl({
            imageUrl: editingCategory.image_url,
            storeId: store.id,
          })
        } catch (caughtError) {
          cleanupWarning = getErrorMessage(caughtError)
        }
      }

      setCategories((currentCategories) => {
        const nextCategories = editingCategory
          ? currentCategories.map((category) =>
              category.id === savedCategory.id ? savedCategory : category,
            )
          : [...currentCategories, savedCategory]

        return sortCategories(nextCategories)
      })

      setNotice({
        type: cleanupWarning ? 'error' : 'success',
        message: editingCategory
          ? cleanupWarning
            ? `Categoria actualizada, pero ${cleanupWarning}`
            : 'Categoria actualizada correctamente.'
          : cleanupWarning
            ? `Categoria creada, pero ${cleanupWarning}`
            : 'Categoria creada correctamente.',
      })
      closeForm()
    } catch (caughtError) {
      setNotice({ type: 'error', message: getErrorMessage(caughtError) })
    } finally {
      setSaving(false)
    }
  }

  async function handleActiveChange(category: Category) {
    const count = productCounts[category.id] ?? 0
    if (
      category.active &&
      count > 0 &&
      !window.confirm(
        `Esta categoria tiene ${count} producto(s) asociado(s). Se conservaran, pero la categoria quedara inactiva. Deseas continuar?`,
      )
    ) {
      return
    }

    try {
      setActionCategoryId(category.id)
      setNotice(null)
      const updatedCategory = await setCategoryActive(
        store.id,
        category.id,
        !category.active,
      )
      setCategories((currentCategories) =>
        sortCategories(
          currentCategories.map((currentCategory) =>
            currentCategory.id === updatedCategory.id
              ? updatedCategory
              : currentCategory,
          ),
        ),
      )
      setNotice({
        type: 'success',
        message: updatedCategory.active
          ? 'Categoria reactivada correctamente.'
          : 'Categoria desactivada correctamente.',
      })
    } catch (caughtError) {
      setNotice({ type: 'error', message: getErrorMessage(caughtError) })
    } finally {
      setActionCategoryId(null)
    }
  }

  return (
    <section id="categorias" className="mx-auto max-w-7xl">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">Modulo activo</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">
            Categorias
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Organiza el catalogo de {store.name} con categorias propias de esta
            tienda.
          </p>
        </div>

        <button
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          onClick={openCreateForm}
          type="button"
        >
          <Plus aria-hidden="true" size={18} />
          Nueva categoria
        </button>
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Categorias" value={categories.length} />
        <Metric label="Activas" value={activeCount} />
        <Metric
          label="Con productos"
          value={Object.keys(productCounts).length}
        />
      </div>

      {notice ? <NoticeBanner notice={notice} /> : null}

      {isFormOpen ? (
        <CategoryForm
          form={form}
          isEditing={Boolean(editingCategory)}
          saving={saving}
          imageFile={imageFile}
          imagePreviewUrl={imagePreviewUrl}
          onCancel={closeForm}
          onImageChange={handleImageChange}
          onImageRemove={handleImageRemove}
          onNameChange={handleNameChange}
          onSlugChange={handleSlugChange}
          onSubmit={handleSubmit}
          setForm={setForm}
        />
      ) : null}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-950">
              Lista de categorias
            </h3>
            <p className="text-sm text-slate-500">
              Ordenadas por prioridad y nombre.
            </p>
          </div>
          <button
            className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loading}
            onClick={() => void loadCategories()}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} />
            Actualizar
          </button>
        </div>

        {loading ? (
          <StatePanel
            icon={<Loader2 className="animate-spin" aria-hidden="true" />}
            title="Cargando categorias"
            text="Estamos consultando Supabase."
          />
        ) : error ? (
          <StatePanel
            icon={<AlertCircle aria-hidden="true" />}
            title="No se pudo cargar la lista"
            text={error}
          />
        ) : categories.length === 0 ? (
          <StatePanel
            icon={<FolderTree aria-hidden="true" />}
            title="Aun no hay categorias"
            text="Crea categorias para ordenar el catalogo de esta tienda."
          />
        ) : (
          <CategoryTable
            actionCategoryId={actionCategoryId}
            categories={categories}
            productCounts={productCounts}
            onActiveChange={handleActiveChange}
            onEdit={openEditForm}
          />
        )}
      </div>
    </section>
  )
}

function CategoryForm({
  form,
  isEditing,
  saving,
  imageFile,
  imagePreviewUrl,
  setForm,
  onCancel,
  onImageChange,
  onImageRemove,
  onNameChange,
  onSlugChange,
  onSubmit,
}: {
  form: FormState
  isEditing: boolean
  saving: boolean
  imageFile: File | null
  imagePreviewUrl: string | null
  setForm: React.Dispatch<React.SetStateAction<FormState>>
  onCancel: () => void
  onImageChange: (file: File | null) => void
  onImageRemove: () => void
  onNameChange: (name: string) => void
  onSlugChange: (slug: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <form
      className="mb-5 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      onSubmit={onSubmit}
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-950">
            {isEditing ? 'Editar categoria' : 'Nueva categoria'}
          </h3>
          <p className="text-sm text-slate-500">
            El slug se usa para lecturas publicas y debe ser unico por tienda.
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

      <div className="mb-4">
        <Field label="Imagen de categoria" htmlFor="category-image">
          <div className="grid gap-3 rounded-md border border-dashed border-slate-300 p-3 sm:grid-cols-[96px_1fr]">
            <CategoryImagePreview imageUrl={imagePreviewUrl} />
            <div>
              <label
                className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                htmlFor="category-image"
              >
                <ImagePlus aria-hidden="true" size={16} />
                Seleccionar imagen
              </label>
              <input
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                id="category-image"
                onChange={(event) =>
                  onImageChange(event.target.files?.[0] ?? null)
                }
                type="file"
              />
              <p className="mt-2 text-xs text-slate-500">
                {imageFile
                  ? imageFile.name
                  : 'JPG, PNG o WebP. Maximo 2 MB.'}
              </p>
              {imagePreviewUrl ? (
                <button
                  className="mt-2 text-xs font-medium text-slate-700 underline"
                  onClick={onImageRemove}
                  type="button"
                >
                  Quitar imagen
                </button>
              ) : null}
            </div>
          </div>
        </Field>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_160px]">
        <Field label="Nombre" htmlFor="category-name">
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            id="category-name"
            maxLength={100}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="Salud y cuidado"
            value={form.name}
          />
        </Field>

        <Field label="Slug" htmlFor="category-slug">
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            id="category-slug"
            maxLength={120}
            onChange={(event) => onSlugChange(event.target.value)}
            placeholder="salud-y-cuidado"
            value={form.slug}
          />
        </Field>

        <Field label="Orden" htmlFor="category-sort-order">
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            id="category-sort-order"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                sort_order: event.target.value,
              }))
            }
            step="1"
            type="number"
            value={form.sort_order}
          />
        </Field>
      </div>

      <div className="mt-4 max-w-xs">
        <Toggle
          checked={form.active}
          label={form.active ? 'Activa' : 'Inactiva'}
          onChange={(active) => setForm((current) => ({ ...current, active }))}
        />
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
    </form>
  )
}

function CategoryTable({
  actionCategoryId,
  categories,
  productCounts,
  onActiveChange,
  onEdit,
}: {
  actionCategoryId: Category['id'] | null
  categories: Category[]
  productCounts: CategoryProductCounts
  onActiveChange: (category: Category) => void
  onEdit: (category: Category) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
          <tr>
            <th className="px-4 py-3">Nombre</th>
            <th className="px-4 py-3">Slug</th>
            <th className="px-4 py-3">Orden</th>
            <th className="px-4 py-3">Productos</th>
            <th className="px-4 py-3">Estado</th>
            <th className="px-4 py-3 text-right">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {categories.map((category) => (
            <tr key={category.id} className={!category.active ? 'bg-slate-50' : ''}>
              <td className="px-4 py-4">
                <div className="flex items-center gap-3">
                  <CategoryImagePreview imageUrl={category.image_url} compact />
                  <span className="font-medium text-slate-950">
                    {category.name}
                  </span>
                </div>
              </td>
              <td className="px-4 py-4 font-mono text-xs text-slate-600">
                {category.slug}
              </td>
              <td className="px-4 py-4 text-slate-700">
                {category.sort_order}
              </td>
              <td className="px-4 py-4 text-slate-700">
                {productCounts[category.id] ?? 0}
              </td>
              <td className="px-4 py-4">
                <StatusPill
                  tone={category.active ? 'blue' : 'slate'}
                  text={category.active ? 'Activa' : 'Inactiva'}
                />
              </td>
              <td className="px-4 py-4">
                <div className="flex justify-end gap-2">
                  <IconButton
                    label="Editar categoria"
                    onClick={() => onEdit(category)}
                  >
                    <Pencil aria-hidden="true" size={16} />
                  </IconButton>
                  <IconButton
                    label={
                      category.active
                        ? 'Desactivar categoria'
                        : 'Reactivar categoria'
                    }
                    loading={actionCategoryId === category.id}
                    onClick={() => onActiveChange(category)}
                  >
                    {category.active ? (
                      <PowerOff aria-hidden="true" size={16} />
                    ) : (
                      <Power aria-hidden="true" size={16} />
                    )}
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

function CategoryImagePreview({
  compact = false,
  imageUrl,
}: {
  compact?: boolean
  imageUrl: string | null
}) {
  const sizeClass = compact ? 'h-12 w-12' : 'h-24 w-24'

  if (!imageUrl) {
    return (
      <div
        className={`flex ${sizeClass} shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-400`}
      >
        <FolderTree aria-hidden="true" size={compact ? 18 : 24} />
      </div>
    )
  }

  return (
    <img
      alt=""
      className={`${sizeClass} shrink-0 rounded-md object-cover`}
      src={imageUrl}
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
  tone: 'blue' | 'slate'
}) {
  const toneClass = {
    blue: 'bg-blue-50 text-blue-800 ring-blue-200',
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

function parseForm(
  form: FormState,
): { value: CategoryFormInput } | { error: string } {
  const name = form.name.trim()
  const slug = slugify(form.slug)
  const sortOrder = Number(form.sort_order)

  if (!name) {
    return { error: 'Ingresa el nombre de la categoria.' }
  }

  if (!slug) {
    return { error: 'Ingresa un slug valido para la categoria.' }
  }

  if (!Number.isInteger(sortOrder)) {
    return { error: 'Ingresa un orden entero valido.' }
  }

  return {
    value: {
      name,
      slug,
      sort_order: sortOrder,
      active: form.active,
    },
  }
}

function sortCategories(categories: Category[]) {
  return [...categories].sort((first, second) => {
    if (first.sort_order !== second.sort_order) {
      return first.sort_order - second.sort_order
    }

    return first.name.localeCompare(second.name)
  })
}

function slugify(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return 'Ocurrio un error inesperado.'
}
