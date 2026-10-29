import { Component, type ErrorInfo, type ReactNode } from 'react'

export class RecoveryBoundary extends Component<{ children: ReactNode }, { failed: boolean; revision: number }> {
  state = { failed: false, revision: 0 }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    console.error('ui_recovery', { category: 'render_error' })
  }
  render() {
    if (this.state.failed) return <section role="alert" className="mx-auto max-w-xl rounded-lg border bg-white p-6">
      <h2 className="text-xl font-semibold">No se pudo mostrar esta pantalla</h2>
      <p className="my-4">Puedes volver al listado e intentar recuperar tu borrador. No se han descartado los borradores guardados. Si seleccionaste una imagen, deberas seleccionarla nuevamente.</p>
      <button type="button" className="rounded bg-slate-950 px-4 py-2 text-white" onClick={() => this.setState(s => ({ failed: false, revision: s.revision + 1 }))}>Volver a intentar</button>
    </section>
    return <div key={this.state.revision}>{this.props.children}</div>
  }
}
