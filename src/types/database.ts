export type Product = {
  id: number
  store_id: number
  name: string
  description: string | null
  price: number
  discount_active: boolean
  discount_price: number | null
  visual_rating: number | null
  image_path: string | null
  category_id: string | null
  available: boolean
  active: boolean
  created_at: string
}

export type ProductInsert = {
  store_id: number
  name: string
  description?: string | null
  price: number
  discount_active?: boolean
  discount_price?: number | null
  visual_rating?: number | null
  image_path?: string | null
  category_id?: string | null
  available: boolean
  active: boolean
}

export type ProductUpdate = Partial<
  Pick<
    Product,
    | 'name'
    | 'description'
    | 'price'
    | 'discount_active'
    | 'discount_price'
    | 'visual_rating'
    | 'image_path'
    | 'category_id'
    | 'available'
    | 'active'
  >
>

export type Category = {
  id: string
  store_id: number
  name: string
  slug: string
  image_url: string | null
  sort_order: number
  active: boolean
  created_at: string
}

export type CategoryInsert = {
  store_id: number
  name: string
  slug: string
  image_url?: string | null
  sort_order?: number
  active?: boolean
}

export type CategoryUpdate = Partial<
  Pick<Category, 'name' | 'slug' | 'image_url' | 'sort_order' | 'active'>
>

export type Store = {
  id: number
  name: string
  slug: string
  owner_user_id: string | null
  created_at: string
}

export type Database = {
  public: {
    Tables: {
      products: {
        Row: Product
        Insert: ProductInsert
        Update: ProductUpdate
        Relationships: []
      }
      categories: {
        Row: Category
        Insert: CategoryInsert
        Update: CategoryUpdate
        Relationships: []
      }
      stores: {
        Row: Store
        Insert: {
          name: string
          slug: string
          owner_user_id?: string | null
        }
        Update: Partial<{
          name: string
          slug: string
          owner_user_id: string | null
        }>
        Relationships: []
      }
    }
    Views: {}
    Functions: {
      create_product_idempotent: {
        Args: {
          p_store_id: number
          p_operation_id: string
          p_input: {
            name: string
            description: string
            price: number
            discount_active: boolean
            discount_price: number | null
            visual_rating: number | null
            category_id: string | null
            available: boolean
          } | null
        }
        Returns: {
          status: 'found' | 'not_found' | 'deleted'
          product: Product | null
          replayed?: boolean
        }
      }
    }
    Enums: {}
    CompositeTypes: {}
  }
}
