import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, CheckCircle2, Eye, EyeOff, Loader2, Save } from 'lucide-react'
import { getSupabaseClient, hasSupabaseConfig, inviteFlow } from '../../lib/supabase'
import { AuthLayout, AuthNotice, authButtonClass, authInputClass } from './AuthLayout'
import { InviteFlowError, passwordError } from './inviteFlow'

export function AcceptInvitePage({ onContinue }: { onContinue: () => void }) {
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [visible, setVisible] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const busy = useRef(false)
  const verifiedUser = useRef<string | null>(null)

  useEffect(() => {
    let current = true
    if (!hasSupabaseConfig) {
      void Promise.resolve().then(() => {
        if (current) { setLoading(false); setError('No se pudo conectar con Supabase. Contacta a Kafka.') }
      })
      return () => { current = false }
    }
    let invalidated = false
    const { data: { subscription } } = getSupabaseClient().auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (verifiedUser.current && session?.user.id !== verifiedUser.current)) {
        invalidated = true
        verifiedUser.current = null
        if (current) {
          setUserId(null)
          setSaved(false)
          setPassword('')
          setConfirmation('')
          setError('La sesion cambio o termino. Abre nuevamente tu invitacion.')
        }
      }
    })
    void inviteFlow.initialize(getSupabaseClient()).then(session => {
      if (current && !invalidated) { verifiedUser.current = session.user.id; setUserId(session.user.id) }
    }).catch(() => {
      if (current) setError('La invitacion no es valida o ha expirado. Solicita un nuevo enlace a Kafka.')
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false; subscription.unsubscribe() }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current || !userId || saved) return
    const invalid = passwordError(password, confirmation)
    if (invalid) { setError(invalid); return }
    busy.current = true
    setSaving(true)
    setError(null)
    try {
      await inviteFlow.updatePassword(getSupabaseClient(), userId, password)
      if (verifiedUser.current !== userId) throw new InviteFlowError('La sesion cambio o termino. Inicia sesion nuevamente.')
      setSaved(true)
      setPassword('')
      setConfirmation('')
    } catch (caught) {
      setError(caught instanceof InviteFlowError ? caught.message : 'No se pudo confirmar el guardado. Revisa tu conexion e intenta nuevamente.')
    } finally { busy.current = false; setSaving(false) }
  }

  function continueToAdmin() {
    inviteFlow.finish()
    onContinue()
  }
  return <AuthLayout title="Crea tu contrasena" description="Completa tu invitacion para acceder a Kafka Admin.">
    {loading ? <p role="status" className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="animate-spin" size={16} />Validando invitacion...</p> : <>
      {error && <AuthNotice message={error} />}
      {saved ? <div className="space-y-4">
        <p role="status" className="flex items-center gap-2 text-sm text-emerald-800"><CheckCircle2 size={18} />Tu contrasena se guardo correctamente.</p>
        <button className={authButtonClass} onClick={continueToAdmin}><ArrowRight size={16} />Continuar al panel</button>
      </div> : userId ? <form onSubmit={submit} className="space-y-4">
        <fieldset disabled={saving} className="space-y-4">
          <PasswordField label="Contrasena nueva" value={password} onChange={setPassword} visible={visible} />
          <PasswordField label="Confirmar contrasena" value={confirmation} onChange={setConfirmation} visible={visible} />
          <button type="button" aria-pressed={visible} onClick={() => setVisible(value => !value)} className="inline-flex min-h-9 items-center gap-2 text-sm font-medium text-slate-700">
            {visible ? <EyeOff size={16} /> : <Eye size={16} />}{visible ? 'Ocultar contrasenas' : 'Mostrar contrasenas'}
          </button>
          <p className="text-sm text-slate-600">Minimo 8 caracteres.</p>
          <button className={authButtonClass} type="submit">{saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}Guardar contrasena</button>
        </fieldset>
      </form> : <button className={authButtonClass} onClick={continueToAdmin}><ArrowRight size={16} />Volver al inicio</button>}
    </>}
  </AuthLayout>
}

function PasswordField({ label, value, onChange, visible }: {
  label: string; value: string; onChange: (value: string) => void; visible: boolean
}) {
  return <label className="block">
    <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
    <input className={authInputClass} autoComplete="new-password" type={visible ? 'text' : 'password'}
      value={value} onChange={event => onChange(event.target.value)} required maxLength={128} />
  </label>
}
