export type Product = {
  id: number
  store_id: number
  name: string
  description: string | null
  price: number
  image_path: string | null
  available: boolean
  active: boolean
  created_at: string
}

export type ProductInsert = {
  store_id: number
  name: string
  description?: string | null
  price: number
  image_path?: string | null
  available: boolean
  active: boolean
}

export type ProductUpdate = Partial<
  Pick<
    Product,
    'name' | 'description' | 'price' | 'image_path' | 'available' | 'active'
  >
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
    Functions: {}
    Enums: {}
    CompositeTypes: {}
  }
}
