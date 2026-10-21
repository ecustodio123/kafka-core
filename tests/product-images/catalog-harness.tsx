import { createRoot } from 'react-dom/client'
import { ProductsPage } from '../../src/features/products/ProductsPage'
import { CategoriesPage } from '../../src/features/categories/CategoriesPage'
import '../../src/index.css'

const store = { id: 1, name: 'LOCAL ONLY', slug: 'local-only', owner_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', created_at: '2026-10-21T00:00:00Z' }
createRoot(document.getElementById('root')!).render(new URL(location.href).searchParams.get('kind') === 'category'
  ? <CategoriesPage store={store} /> : <ProductsPage store={store} />)
