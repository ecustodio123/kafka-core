export function Toggle({ checked, label, onChange, disabled = false }: {
  checked: boolean; label: string; onChange: (checked: boolean) => void; disabled?: boolean
}) {
  return <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700">
    {label}<input checked={checked} disabled={disabled} className="h-4 w-4 accent-slate-950" onChange={event => onChange(event.target.checked)} type="checkbox" />
  </label>
}
