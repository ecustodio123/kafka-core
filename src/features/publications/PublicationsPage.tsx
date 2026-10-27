import { cloneElement, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactElement, ReactNode } from 'react'
import { Download, FileText, Loader2, Pencil, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import type { Publication, PublicationInput, Store } from '../../types/database'
import { createPublication, deletePublication, linkPublicationPdf, listPublications, updatePublication } from '../../services/publications'
import { ensurePublicationPdf, preparePublicationPdf, publicationFilePath, signedPublicationPdf } from '../../services/publicationFiles'
import type { PdfUpload, PreparedPdf } from '../../services/publicationFiles'
import { slugifyPathSegment } from '../../services/pathSlugs'
import { emptyPublicationForm, parsePublicationForm, publicationForm } from './publicationForm'

const button = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50'
const inputClass = 'w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200'
const states = { draft: 'Borrador', published: 'Publicado', archived: 'Archivado' }
const sorted = (rows: Publication[]) => [...rows].sort((a, b) => a.display_order - b.display_order
  || (b.published_at ?? '').localeCompare(a.published_at ?? '') || a.id.localeCompare(b.id))
const message = (e: unknown) => e instanceof Error ? e.message : 'No se pudo confirmar la operacion.'

export function PublicationsPage({ store, enabled }: { store: Store; enabled: boolean }) {
  const [rows, setRows] = useState<Publication[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ ...emptyPublicationForm })
  const [saving, setSaving] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [record, setRecord] = useState<Publication | null>(null)
  const [prepared, setPrepared] = useState<PreparedPdf | null>(null)
  const [uploadStarted, setUploadStarted] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [link, setLink] = useState<{ id: string; url: string } | null>(null)
  const busy = useRef(false), selecting = useRef(false), alive = useRef(true), reads = useRef(0), selection = useRef(0)
  const confirmed = useRef<Publication | null>(null)
  const creation = useRef<{ id: string; input: PublicationInput } | null>(null)
  const baseline = useRef<PublicationInput | null>(null)
  const upload = useRef<PdfUpload | null>(null)
  const expectedPdf = useRef<string | null>(null)
  const slugEdited = useRef(false)
  const reload = useCallback(async () => {
    const request = ++reads.current
    setLoading(true); setLoadError(null); setLink(null)
    try {
      const next = await listPublications(store.id)
      if (alive.current && request === reads.current) setRows(next)
    } catch (caught) {
      if (alive.current && request === reads.current) { setRows([]); setLoadError(message(caught)) }
    } finally { if (alive.current && request === reads.current) setLoading(false) }
  }, [store.id])
  useEffect(() => {
    const mounted = alive, requests = reads, selections = selection
    mounted.current = true
    let current = true
    void Promise.resolve().then(() => { if (current) void reload() })
    return () => { current = false; mounted.current = false; requests.current++; selections.current++ }
  }, [reload])
  useEffect(() => {
    if (!link) return
    const timer = setTimeout(() => setLink(null), 55000)
    return () => clearTimeout(timer)
  }, [link])

  function edit(row: Publication | null) {
    if (busy.current) return
    selection.current++; selecting.current = false; setPreparing(false)
    confirmed.current = row; creation.current = null; upload.current = null
    expectedPdf.current = row?.pdf_storage_path ?? null
    baseline.current = row ? parsePublicationForm(publicationForm(row)) : null
    slugEdited.current = row !== null
    setRecord(row); setForm(row ? publicationForm(row) : { ...emptyPublicationForm }); setPrepared(null); setUploadStarted(false)
    setOpen(true); setNotice(null); setLink(null)
  }
  function close() {
    if (busy.current) return
    selection.current++; selecting.current = false; setPreparing(false); setPrepared(null); setOpen(false)
  }
  async function selectPdf(file: File | null) {
    if (!file || busy.current) return
    const request = ++selection.current
    selecting.current = true; setPreparing(true)
    try {
      const next = await preparePublicationPdf(file)
      if (!alive.current || request !== selection.current) return
      if (upload.current?.phase === 'attempted') throw new Error('Hay una subida sin confirmar. Verifica la misma operacion antes de elegir otro PDF.')
      setPrepared(next); upload.current = null; setUploadStarted(false)
      expectedPdf.current = confirmed.current?.pdf_storage_path ?? null
      setNotice(null)
    } catch (caught) { if (alive.current && request === selection.current) setNotice({ error: true, text: message(caught) }) }
    finally { if (alive.current && request === selection.current) { selecting.current = false; setPreparing(false) } }
  }
  function accept(row: Publication) {
    confirmed.current = row; setRecord(row)
    setRows(current => sorted([...current.filter(item => item.id !== row.id), row]))
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current || selecting.current) return
    let input: PublicationInput
    try {
      input = parsePublicationForm(form)
      if (input.status === 'published' && input.publication_type === 'document' && !prepared && !confirmed.current?.pdf_storage_path) {
        throw new Error('Selecciona un PDF antes de publicar el documento, o guarda como borrador.')
      }
    } catch (caught) { setNotice({ error: true, text: message(caught) }); return }
    busy.current = true; setSaving(true); setNotice(null); setLink(null)
    try {
      let saved = confirmed.current
      if (!saved) {
        const draft = { ...input, status: 'draft' as const }
        creation.current ??= { id: crypto.randomUUID(), input: draft }
        if (JSON.stringify(creation.current.input) !== JSON.stringify(draft)) throw new Error('La creacion anterior no se confirmo. Reintenta con los mismos datos o actualiza la lista antes de crear otra publicacion.')
        saved = await createPublication(store.id, creation.current.id, draft)
        if (!alive.current) return
        accept(saved); baseline.current = draft
      }
      if (prepared) {
        upload.current ??= { prepared, path: publicationFilePath(store, saved, prepared.id), phase: 'prepared' }
        setUploadStarted(true)
        await ensurePublicationPdf(upload.current)
        if (!alive.current) return
        saved = await linkPublicationPdf(store.id, saved.id, expectedPdf.current, {
          pdf_storage_path: upload.current.path, pdf_original_name: prepared.file.name, pdf_size_bytes: prepared.file.size,
        })
        if (!alive.current) return
        accept(saved); expectedPdf.current = saved.pdf_storage_path
      }
      if (JSON.stringify(baseline.current) !== JSON.stringify(input)) {
        saved = await updatePublication(store.id, saved.id, input)
        if (!alive.current) return
        accept(saved); baseline.current = input
      }
      setPrepared(null); upload.current = null; setUploadStarted(false); setOpen(false)
      setNotice({ error: false, text: 'Publicacion guardada correctamente.' })
    } catch (caught) {
      if (alive.current) setNotice({ error: true, text: `${confirmed.current ? 'La publicacion conserva su ID. ' : ''}${message(caught)}` })
    } finally { busy.current = false; if (alive.current) setSaving(false) }
  }
  async function rowAction(row: Publication, action: 'delete' | 'pdf') {
    if (busy.current || open) return
    if (action === 'delete' && !window.confirm(`Eliminar la publicacion "${row.title}"? Esta accion no se puede deshacer.`)) return
    busy.current = true; setSaving(true); setNotice(null); setLink(null)
    try {
      if (action === 'delete') {
        await deletePublication(store.id, row.id)
        if (alive.current) { setRows(current => current.filter(item => item.id !== row.id)); setNotice({ error: false, text: 'Publicacion eliminada correctamente.' }) }
      } else {
        const url = await signedPublicationPdf(store.id, row.id)
        if (alive.current) setLink({ id: row.id, url })
      }
    } catch (caught) { if (alive.current) setNotice({ error: true, text: message(caught) }) }
    finally { busy.current = false; if (alive.current) setSaving(false) }
  }
  const filtered = rows.filter(row => row.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()) && (filter === 'all' || row.status === filter))
  return <section className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-xl font-semibold">Publicaciones</h2><p className="text-sm text-slate-600">{store.name}</p></div>
      <button className={button} disabled={loading || saving || open} onClick={() => edit(null)}><Plus size={16} />Nueva publicacion</button>
    </div>
    {!enabled && <p className="border-l-4 border-amber-500 bg-amber-50 p-3 text-sm">Modulo deshabilitado. Solo Super Admin puede administrar este contenido.</p>}
    {notice && <p role={notice.error ? 'alert' : 'status'} className={`rounded-md border p-3 text-sm ${notice.error ? 'border-red-200 bg-red-50 text-red-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>{notice.text}</p>}
    {open && <form onSubmit={submit} className="space-y-4 border-y border-slate-300 bg-white p-4">
      <div className="flex items-center justify-between"><h3 className="font-semibold">{record ? 'Editar publicacion' : 'Nueva publicacion'}</h3><button type="button" className={button} aria-label="Cerrar formulario" title="Cerrar formulario" disabled={saving} onClick={close}><X size={16} /></button></div>
      <fieldset disabled={saving || preparing} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Titulo"><input className={inputClass} maxLength={200} value={form.title} onChange={event => { const title = event.target.value; setForm(current => ({ ...current, title, slug: slugEdited.current ? current.slug : slugifyPathSegment(title) })) }} /></Field>
          <Field label="Slug"><input className={inputClass} maxLength={120} value={form.slug} onChange={event => { slugEdited.current = true; setForm(current => ({ ...current, slug: event.target.value })) }} /></Field>
          <Field label="Categoria"><input className={inputClass} maxLength={200} value={form.category} onChange={event => setForm(current => ({ ...current, category: event.target.value }))} /></Field>
          <Field label="Tipo"><select className={inputClass} value={form.publication_type} onChange={event => setForm(current => ({ ...current, publication_type: event.target.value as Publication['publication_type'] }))}><option value="document">Documento PDF</option><option value="article">Articulo</option></select></Field>
          <Field label="Estado"><select className={inputClass} value={form.status} onChange={event => setForm(current => ({ ...current, status: event.target.value as Publication['status'] }))}>{Object.entries(states).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></Field>
          <Field label="Orden"><input className={inputClass} type="number" step="1" value={form.display_order} onChange={event => setForm(current => ({ ...current, display_order: event.target.value }))} /></Field>
        </div>
        <Field label="Resumen"><textarea className={inputClass} rows={3} maxLength={5000} value={form.summary} onChange={event => setForm(current => ({ ...current, summary: event.target.value }))} /></Field>
        <div className="space-y-2"><label className={`${button} cursor-pointer`}><FileText size={16} />Seleccionar PDF<input aria-label="Archivo PDF" type="file" className="sr-only" accept="application/pdf,.pdf" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void selectPdf(file) }} /></label>
          <p className="break-all text-sm text-slate-600">{prepared ? `Seleccionado: ${prepared.file.name}` : record?.pdf_original_name ?? 'Sin PDF'}{record?.pdf_size_bytes ? ` · ${Math.ceil(record.pdf_size_bytes / 1024)} KB` : ''}</p>
          {preparing && <p role="status" className="text-sm">Preparando PDF...</p>}
          {prepared && !uploadStarted && <button type="button" className={button} onClick={() => setPrepared(null)}><X size={16} />Quitar seleccion</button>}
        </div>
        <button type="submit" className={`${button} bg-slate-950 text-white hover:bg-slate-800`} disabled={saving || preparing}>{saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}{saving ? 'Guardando...' : 'Guardar'}</button>
      </fieldset>
    </form>}
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1"><Field label="Buscar por titulo"><input className={inputClass} value={search} onChange={event => setSearch(event.target.value)} type="search" /></Field></div>
      <Field label="Filtrar estado"><select className={inputClass} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Todos</option>{Object.entries(states).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></Field>
      <button className={button} disabled={loading || saving || open} onClick={() => void reload()}><RefreshCw size={16} />Actualizar</button>
    </div>
    {loading ? <p role="status" className="flex items-center gap-2 py-8"><Loader2 size={18} className="animate-spin" />Cargando publicaciones...</p>
      : loadError ? <p role="alert">{loadError}</p> : !filtered.length ? <p className="py-8 text-sm text-slate-600">No hay publicaciones para mostrar.</p>
      : <ul className="divide-y divide-slate-200 border-y border-slate-200 bg-white">{filtered.map(row => <li key={row.id} className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap">
        <FileText size={24} className="shrink-0 text-slate-500" aria-hidden="true" />
        <div className="min-w-0 flex-1 basis-48"><h4 className="break-words text-sm font-semibold">{row.title}</h4>
          <p className="break-words text-xs text-slate-600">{row.category || 'Sin categoria'} · {states[row.status]} · Orden {row.display_order}</p>
          <p className="break-all text-xs text-slate-500">{row.pdf_original_name ?? 'Sin PDF'} · {row.published_at ? new Date(row.published_at).toLocaleDateString('es-PE') : 'Sin publicar'}</p>
          {link?.id === row.id && <a href={link.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="text-sm underline">Abrir o descargar PDF</a>}
        </div>
        <div className="flex shrink-0 gap-2">
          {row.pdf_storage_path && <Action label={`Ver PDF de ${row.title}`} disabled={saving || open} onClick={() => void rowAction(row, 'pdf')}><Download size={16} /></Action>}
          <Action label={`Editar ${row.title}`} disabled={saving || open} onClick={() => edit(row)}><Pencil size={16} /></Action>
          <Action label={`Eliminar ${row.title}`} disabled={saving || open} onClick={() => void rowAction(row, 'delete')}><Trash2 size={16} /></Action>
        </div>
      </li>)}</ul>}
  </section>
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  return <div className="min-w-0"><label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">{label}</label>{cloneElement(children as ReactElement<{ id: string }>, { id })}</div>
}
function Action({ label, children, disabled, onClick }: { label: string; children: ReactNode; disabled: boolean; onClick: () => void }) {
  return <button className={`${button} h-10 w-10 p-2`} type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button>
}
