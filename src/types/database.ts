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

export type StoreFeatures = {
  store_id: number
  commerce_enabled: boolean | null
  services_enabled: boolean | null
  staff_enabled: boolean | null
  publications_enabled: boolean | null
}
export type ModuleFlags = Omit<StoreFeatures, 'store_id'>

export type ModuleKind = 'services' | 'staff'
export type ModuleRecord = {
  id: string
  store_id: number
  name?: string
  title: string | null
  description: string | null
  image_url: string | null
  sort_order: number | null
  is_active: boolean | null
}
export type ServiceRecord = Omit<ModuleRecord, 'name' | 'title'> & { title: string }
export type StaffRecord = ModuleRecord & { name: string }
type ServiceInsert = Pick<ServiceRecord, 'store_id' | 'title' | 'description' | 'sort_order' | 'is_active'>
type StaffInsert = Pick<StaffRecord, 'store_id' | 'name' | 'title' | 'description' | 'sort_order' | 'is_active'>

export type Publication = {
  id: string; store_id: number; title: string; slug: string; summary: string | null
  category: string | null; publication_type: 'document' | 'article'; content: string | null
  pdf_storage_path: string | null; pdf_original_name: string | null; pdf_size_bytes: number | null
  cover_storage_path: string | null; status: 'draft' | 'published' | 'archived'; display_order: number
  published_at: string | null; created_by: string | null; created_at: string; updated_at: string
}
export type PublicationInput = Pick<Publication, 'title' | 'slug' | 'summary' | 'category' | 'publication_type' | 'status' | 'display_order'>
type PublicationInsert = Pick<Publication, 'id' | 'store_id'> & PublicationInput

export type Database = {
  public: {
    Tables: {
      publications: {
        Row: Publication
        Insert: PublicationInsert
        Update: Partial<PublicationInput & Pick<Publication, 'pdf_storage_path' | 'pdf_original_name' | 'pdf_size_bytes'>>
        Relationships: []
      }
      services: {
        Row: ServiceRecord
        Insert: ServiceInsert
        Update: Partial<Omit<ServiceRecord, 'id' | 'store_id'>>
        Relationships: []
      }
      staff: {
        Row: StaffRecord
        Insert: StaffInsert
        Update: Partial<Omit<StaffRecord, 'id' | 'store_id'>>
        Relationships: []
      }
      store_features: {
        Row: StoreFeatures
        Insert: StoreFeatures
        Update: Partial<ModuleFlags>
        Relationships: []
      }
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
