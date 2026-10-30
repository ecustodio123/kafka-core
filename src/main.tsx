import { RecoveryBoundary } from './components/RecoveryBoundary'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// One sanitized reporter shared with the nearest boundary; never log raw errors.
createRoot(document.getElementById('root')!, { onCaughtError: RecoveryBoundary.onCaughtError }).render(
  <StrictMode>
    <RecoveryBoundary><App /></RecoveryBoundary>
  </StrictMode>,
)
