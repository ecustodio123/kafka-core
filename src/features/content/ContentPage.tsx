import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ImagePlus, Image as ImageIcon, Loader2, Pencil, Plus, Power, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { Toggle } from '../../components/Toggle'
import { createModuleContent, deleteModuleContent, linkModuleImage, listModuleContent, setModuleActive, updateModuleContent } from '../../services/moduleContent'
import { beginModuleImage, ensureModuleImage, prepareModuleImage } from '../../services/moduleImages'
import type { ContentImage } from '../../services/moduleImages'
import type { PreparedProductImage } from '../../services/productImagePreparation'
import type { ModuleKind, ModuleRecord, Store } from '../../types/database'
import { contentForm, contentHeading, emptyContentForm, parseContentForm } from './contentForm'
import type { ContentInput } from './contentForm'

const button = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50'
const inputClass = 'w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200'
function sorted(rows: ModuleRecord[]) {
  return [...rows].sort((a, b) => (a.sort_order === null ? b.sort_order === null ? 0 : 1 : b.sort_order === null ? -1 : a.sort_order - b.sort_order)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
function errorText(error: unknown) { return error instanceof Error ? error.message : 'No se pudo confirmar la operacion.' }

export function ContentPage({ kind, store, enabled }: { kind: ModuleKind; store: Store; enabled: boolean }) {
  const staff = kind === 'staff'
  const heading = staff ? 'Staff' : 'Servicios'
  const singular = staff ? 'profesional' : 'servicio'
  const [rows, setRows] = useState<ModuleRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [record, setRecord] = useState<ModuleRecord | null>(null)
  const [form, setForm] = useState({ ...emptyContentForm })
  const [saving, setSaving] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [prepared, setPrepared] = useState<PreparedProductImage | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [removeImage, setRemoveImage] = useState(false)
  const [creationUncertain, setCreationUncertain] = useState(false)
  const busy = useRef(false)
  const preparingRef = useRef(false)
  const alive = useRef(true)
  const reads = useRef(0)
  const selection = useRef(0)
  const localPreview = useRef<string | null>(null)
  const image = useRef<ContentImage | null>(null)
  const expectedImage = useRef<string | null>(null)
  const baseline = useRef<ContentInput | null>(null)
  const confirmed = useRef<ModuleRecord | null>(null)

  const reload = useCallback(async () => {
    const request = ++reads.current
    setLoading(true)
    setLoadError(null)
    try {
      const data = await listModuleContent(kind, store.id)
      if (alive.current && request === reads.current) setRows(data)
    } catch (caught) {
      if (alive.current && request === reads.current) { setRows([]); setLoadError(errorText(caught)) }
    } finally { if (alive.current && request === reads.current) setLoading(false) }
  }, [kind, store.id])

  useEffect(() => {
    const lifecycle = alive, requests = reads, selections = selection, objectUrl = localPreview
    lifecycle.current = true
    let current = true
    void Promise.resolve().then(() => { if (current) void reload() })
    return () => {
      current = false; lifecycle.current = false; requests.current++; selections.current++
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    }
  }, [reload])

  function clearImage() {
    selection.current++
    preparingRef.current = false
    setPreparing(false)
    if (localPreview.current) URL.revokeObjectURL(localPreview.current)
    localPreview.current = null
    image.current = null
    setPrepared(null); setPreview(null); setRemoveImage(false)
  }
  function edit(next: ModuleRecord | null) {
    clearImage()
    confirmed.current = next
    expectedImage.current = next?.image_url ?? null
    baseline.current = null
    // Existing data outside UI limits must remain openable for correction.
    if (next) {
      try { baseline.current = parseContentForm(kind, contentForm(kind, next)) } catch { /* Validate on submit. */ }
    }
    setRecord(next)
    setForm(next ? contentForm(kind, next) : { ...emptyContentForm })
    setCreationUncertain(false); setOpen(true); setNotice(null)
  }
  function close() {
    if (busy.current) return
    clearImage(); setOpen(false); setRecord(null); confirmed.current = null; baseline.current = null
  }
  async function selectImage(file: File | null) {
    if (!file) return
    const request = ++selection.current
    preparingRef.current = true; setPreparing(true)
    try {
      const next = await prepareModuleImage(file)
      if (!alive.current || request !== selection.current) return
      if (localPreview.current) URL.revokeObjectURL(localPreview.current)
      localPreview.current = URL.createObjectURL(next.blob)
      setPreview(localPreview.current); setPrepared(next); setRemoveImage(false)
      expectedImage.current = confirmed.current?.image_url ?? null
      image.current = null; setNotice(null)
    } catch (caught) {
      if (alive.current && request === selection.current) setNotice({ error: true, text: errorText(caught) })
    } finally {
      if (alive.current && request === selection.current) { preparingRef.current = false; setPreparing(false) }
    }
  }
  function accept(saved: ModuleRecord) {
    confirmed.current = saved
    setRecord(saved)
    setRows(current => sorted([...current.filter(row => row.id !== saved.id), saved]))
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current || preparingRef.current || creationUncertain) return
    let data: ContentInput
    try { data = parseContentForm(kind, form) }
    catch (caught) { setNotice({ error: true, text: errorText(caught) }); return }
    busy.current = true; setSaving(true); setNotice(null)
    let creating = false
    try {
      let saved = confirmed.current
      if (!saved) {
        creating = true
        saved = await createModuleContent(kind, store.id, data)
        creating = false
        if (!alive.current) return
        accept(saved); baseline.current = data
      } else if (JSON.stringify(baseline.current) !== JSON.stringify(data)) {
        saved = await updateModuleContent(kind, store.id, saved.id, data)
        if (!alive.current) return
        accept(saved); baseline.current = data
      }
      if (prepared) {
        image.current ??= beginModuleImage(kind, store, saved, prepared)
        await ensureModuleImage(kind, image.current)
        if (!alive.current) return
        saved = await linkModuleImage(kind, store.id, saved.id, expectedImage.current, image.current.url)
      } else if (removeImage && saved.image_url) {
        saved = await linkModuleImage(kind, store.id, saved.id, expectedImage.current, null)
      }
      if (!alive.current) return
      accept(saved); clearImage(); setOpen(false)
      setNotice({ error: false, text: `${staff ? 'Profesional' : 'Servicio'} guardado correctamente.` })
    } catch (caught) {
      if (!alive.current) return
      if (creating) setCreationUncertain(true)
      const prefix = creating
        ? 'No se confirmo la creacion. Cierra el formulario y actualiza la lista antes de crear otro registro. '
        : confirmed.current && (prepared || removeImage)
          ? 'El registro conserva su ID. No se completo el guardado; puedes reintentar o quitar la seleccion de imagen. '
          : ''
      setNotice({ error: true, text: prefix + errorText(caught) })
    } finally { busy.current = false; if (alive.current) setSaving(false) }
  }
  async function rowAction(row: ModuleRecord, action: 'delete' | 'toggle') {
    if (busy.current || open) return
    if (action === 'delete' && !window.confirm(`Eliminar ${singular} "${contentHeading(kind, row)}"? Esta accion no elimina archivos de Storage.`)) return
    busy.current = true; setSaving(true); setNotice(null)
    try {
      if (action === 'delete') {
        await deleteModuleContent(kind, store.id, row.id)
        if (alive.current) setRows(current => current.filter(item => item.id !== row.id))
      } else {
        const saved = await setModuleActive(kind, store.id, row.id, !row.is_active)
        if (alive.current) setRows(current => sorted(current.map(item => item.id === saved.id ? saved : item)))
      }
      if (alive.current) setNotice({ error: false, text: action === 'delete' ? 'Registro eliminado.' : 'Estado actualizado.' })
    } catch (caught) { if (alive.current) setNotice({ error: true, text: errorText(caught) }) }
    finally { busy.current = false; if (alive.current) setSaving(false) }
  }
  const imageUrl = removeImage ? null : preview ?? record?.image_url ?? null
  return <section className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-xl font-semibold">{heading}</h2><p className="text-sm text-slate-600">{store.name} · {enabled ? 'Habilitado' : 'Deshabilitado'}</p></div>
      <button className={button} disabled={loading || saving || open} onClick={() => edit(null)}><Plus size={16} />Nuevo {singular}</button>
    </div>
    {!enabled && <p className="border-l-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-950">Modulo deshabilitado. Solo Super Admin puede administrar este contenido.</p>}
    {notice && <p role={notice.error ? 'alert' : 'status'} className={`rounded-md border p-3 text-sm ${notice.error ? 'border-red-200 bg-red-50 text-red-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>{notice.text}</p>}
    {open && <form onSubmit={submit} className="space-y-4 border-y border-slate-300 bg-white p-4">
      <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{record ? `Editar ${singular}` : `Nuevo ${singular}`}</h3>
        <button className={button} title="Cerrar formulario" aria-label="Cerrar formulario" type="button" disabled={saving} onClick={close}><X size={16} /></button>
      </div>
      <fieldset disabled={saving || creationUncertain} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={staff ? 'Nombre' : 'Titulo'}><input className={inputClass} value={form.heading} maxLength={200} onChange={event => setForm(value => ({ ...value, heading: event.target.value }))} /></Field>
          {staff && <Field label="Cargo o especialidad"><input className={inputClass} value={form.title} maxLength={200} onChange={event => setForm(value => ({ ...value, title: event.target.value }))} /></Field>}
          <Field label="Orden"><input className={inputClass} type="number" step="1" value={form.sort_order} onChange={event => setForm(value => ({ ...value, sort_order: event.target.value }))} /></Field>
        </div>
        <Field label="Descripcion"><textarea className={inputClass} rows={3} maxLength={5000} value={form.description} onChange={event => setForm(value => ({ ...value, description: event.target.value }))} /></Field>
        <div className="max-w-xs"><Toggle checked={form.is_active} label={form.is_active ? 'Activo - Publicar' : 'Inactivo - Borrador'} onChange={value => setForm(current => ({ ...current, is_active: value }))} /></div>
        <div className="flex flex-wrap items-center gap-4">
          <Preview url={imageUrl} large />
          <div className="space-y-2">
            <label className={`${button} cursor-pointer`}><ImagePlus size={16} />Seleccionar imagen
              <input aria-label="Imagen" className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={saving || preparing} onChange={event => { void selectImage(event.target.files?.[0] ?? null); event.target.value = '' }} />
            </label>
            <p className="text-xs text-slate-600">Imagen opcional. JPG, PNG o WebP, hasta 60 MB. Se optimiza automaticamente.</p>
            {preparing && <p role="status" className="text-sm">Preparando imagen...</p>}
            {(imageUrl || prepared) && <button className={button} type="button" onClick={() => { clearImage(); setRemoveImage(true) }}><X size={16} />Quitar imagen</button>}
          </div>
        </div>
        <button className={`${button} bg-slate-950 text-white hover:bg-slate-800`} disabled={saving || preparing} type="submit">{saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}{saving ? 'Guardando...' : 'Guardar'}</button>
      </fieldset>
    </form>}
    <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{rows.length} {staff ? 'profesionales' : 'servicios'}</h3>
      <button className={button} disabled={loading || saving || open} onClick={() => void reload()}><RefreshCw size={16} />Actualizar</button></div>
    {loading ? <p role="status" className="flex items-center gap-2 py-8 text-sm text-slate-600"><Loader2 size={18} className="animate-spin" />Cargando {heading.toLowerCase()}...</p>
      : loadError ? <p role="alert" className="text-sm text-red-800">{loadError}</p>
      : !rows.length ? <p className="py-8 text-sm text-slate-600">Aun no hay {staff ? 'profesionales' : 'servicios'} en esta tienda.</p>
      : <ul className="divide-y divide-slate-200 border-y border-slate-200 bg-white">
        {rows.map(row => <li key={row.id} className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap">
          <Preview url={row.image_url} />
          <div className="min-w-0 flex-1 basis-40"><h4 className="break-words text-sm font-semibold">{contentHeading(kind, row)}</h4>
            {staff && row.title && <p className="break-words text-sm text-slate-600">{row.title}</p>}
            <p className="text-xs text-slate-500">Orden {row.sort_order ?? 'sin asignar'} - {row.is_active ? 'Activo' : 'Inactivo'}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Action label={`Editar ${contentHeading(kind, row)}`} disabled={saving || open} onClick={() => edit(row)}><Pencil size={16} /></Action>
            <Action label={`${row.is_active ? 'Desactivar' : 'Activar'} ${contentHeading(kind, row)}`} disabled={saving || open} onClick={() => void rowAction(row, 'toggle')}><Power size={16} /></Action>
            <Action label={`Eliminar ${contentHeading(kind, row)}`} disabled={saving || open} onClick={() => void rowAction(row, 'delete')}><Trash2 size={16} /></Action>
          </div>
        </li>)}
      </ul>}
  </section>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0"><span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>{children}</label>
}
function Preview({ url, large = false }: { url: string | null; large?: boolean }) {
  const style = `${large ? 'h-24 w-24' : 'h-14 w-14'} shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-100`
  return url ? <img alt="" className={`${style} object-cover`} src={url} /> : <div className={`${style} flex items-center justify-center text-slate-400`}><ImageIcon size={22} aria-hidden="true" /></div>
}
function Action({ label, children, disabled, onClick }: { label: string; children: ReactNode; disabled: boolean; onClick: () => void }) {
  return <button className={`${button} h-10 w-10 p-2`} type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button>
}
