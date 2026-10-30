import { Component, type ErrorInfo, type ReactNode } from 'react'
import { recordUIIncident, type IncidentModule, type UIIncident } from '../services/imageDiagnostics'

type Props = { children: ReactNode; module?: IncidentModule; onLeave?: () => void; report?: (error: unknown, info: unknown) => UIIncident }
export class RecoveryBoundary extends Component<Props, { failed: boolean; revision: number; incident: UIIncident | null; attempts: number }> {
  state = { failed: false, revision: 0, incident: null as UIIncident | null, attempts: 0 }
  private reported: UIIncident | null = null
  static getDerivedStateFromError() { return { failed: true } }
  report(error: unknown, info: unknown) {
    if (this.reported) return
    try { this.reported = this.props.report?.(error, info) ?? recordUIIncident(error, info, this.props.module) }
    catch { this.reported = recordUIIncident(error, undefined, this.props.module) }
    this.setState({ incident: this.reported })
  }
  componentDidCatch(error: Error, info: ErrorInfo) { this.report(error, info) }
  render() {
    if (this.state.failed) return <section role="alert" className="mx-auto max-w-xl rounded-lg border bg-white p-6">
      <h2 className="text-xl font-semibold">No se pudo mostrar esta pantalla</h2>
      <p className="my-4">Puedes volver al listado e intentar recuperar tu borrador. No se han descartado los borradores guardados. Si seleccionaste una imagen, deberas seleccionarla nuevamente.</p>
      <p className="my-3 text-sm">Codigo de incidente: <strong className="break-all">{this.state.incident?.id ?? 'KC-LOCAL'}</strong></p>
      <p className="mb-3 text-sm">Diagnostico local. No se ha enviado un informe a soporte.</p>
      {this.state.attempts < 2 ? <button type="button" className="rounded bg-slate-950 px-4 py-2 text-white" onClick={() => {
        this.reported = null
        this.setState(s => ({ failed: false, incident: null, revision: s.revision + 1, attempts: s.attempts + 1 }))
      }}>Volver a intentar</button> : <p>El error persiste. Puedes ir a otro modulo sin descartar los borradores guardados.</p>}
      {this.props.onLeave ? <button type="button" className="mt-4 block underline" onClick={this.props.onLeave}>Ir a otro modulo</button> : <a className="mt-4 block underline" href="/">Volver al inicio</a>}
    </section>
    return <div key={this.state.revision}>{this.props.children}</div>
  }
  // React and componentDidCatch share this per-boundary reporter; no raw/default double logging.
  static onCaughtError(error: unknown, info: { componentStack?: string | null; errorBoundary?: Component | null }) {
    try {
      if (info.errorBoundary instanceof RecoveryBoundary) info.errorBoundary.report(error, info)
      else recordUIIncident(error, info)
    } catch { /* Never throw from React's reporting hook. */ }
  }
}
