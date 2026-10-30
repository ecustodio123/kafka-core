import { RecoveryBoundary } from '../../src/components/RecoveryBoundary'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProductsPage } from '../../src/features/products/ProductsPage'
import { prepareProductImage } from '../../src/services/productImagePreparation'
import { convertImageToWebp, optimizeImage } from '../../src/services/imageProcessing'
import { prepareModuleImage } from '../../src/services/moduleImages'
import { prepareCategoryImage, uploadCategoryImage } from '../../src/services/categoryImages'
import '../../src/index.css'

Object.assign(window, { imageTests: { prepareProductImage, convertImageToWebp, optimizeImage, prepareModuleImage, prepareCategoryImage, uploadCategoryImage } })
export function StabilityHarness() {
  const [visible, setVisible] = useState(true)
  const [storeId, setStoreId] = useState(1)
  const [fault, setFault] = useState<string | null>(null)
  return <><div>{['effect', 'persistent', 'reporter'].map(kind => <button key={kind} onClick={() => setFault(kind)}>Test fallo {kind}</button>)}<button onClick={() => setVisible(v => !v)}>Test navegar</button><button onClick={() => setStoreId(v => v === 1 ? 2 : 1)}>Test cambiar tienda</button></div>{fault ? <RecoveryBoundary key={fault} module="products" onLeave={() => setFault(null)} report={fault === 'reporter' ? () => { throw new Error('instrumentation unavailable') } : undefined}><BoundaryFault kind={fault} /></RecoveryBoundary> : visible && <HarnessProducts key={storeId} storeId={storeId} />}</>
}
export function BoundaryFault({ kind }: { kind: string }) {
  useEffect(() => { if (kind === 'effect') throw new TypeError('sensitive effect error token=secret') }, [kind])
  if (kind !== 'effect') throw new Error('private file customer.jpg product text')
  return <p>Transient component</p>
}
export function HarnessProducts({ storeId }: { storeId: number }) { return (
  <main className="px-4 py-6 sm:px-6 lg:px-8">
  <ProductsPage userId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" store={{ id: storeId, name: 'LOCAL STORE', slug: 'local-store',
    owner_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', created_at: '2026-10-17T00:00:00Z' }} />
  </main>
) }
createRoot(document.getElementById('root')!, { onCaughtError: RecoveryBoundary.onCaughtError }).render(<StabilityHarness />)
