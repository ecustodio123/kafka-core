import { createRoot } from 'react-dom/client'
import { ProductsPage } from '../../src/features/products/ProductsPage'
import { prepareProductImage } from '../../src/services/productImagePreparation'
import { convertImageToWebp, optimizeImage } from '../../src/services/imageProcessing'
import { prepareModuleImage } from '../../src/services/moduleImages'
import { prepareCategoryImage, uploadCategoryImage } from '../../src/services/categoryImages'
import '../../src/index.css'

Object.assign(window, { imageTests: { prepareProductImage, convertImageToWebp, optimizeImage, prepareModuleImage, prepareCategoryImage, uploadCategoryImage } })
createRoot(document.getElementById('root')!).render(
  <main className="px-4 py-6 sm:px-6 lg:px-8">
  <ProductsPage store={{ id: 1, name: 'LOCAL STORE', slug: 'local-store',
    owner_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', created_at: '2026-10-17T00:00:00Z' }} />
  </main>,
)
