import { RecoveryBoundary } from './components/RecoveryBoundary'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// RecoveryBoundary emits a fixed category; suppress React's raw caught-error logging.
createRoot(document.getElementById('root')!, { onCaughtError: () => {} }).render(
  <StrictMode>
    <RecoveryBoundary><App /></RecoveryBoundary>
  </StrictMode>,
)
