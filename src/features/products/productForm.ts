import type { Category } from '../../types/database.ts'
import type { ProductCreationInput } from '../../services/productCreation.ts'

export type ProductFormState = {
  name: string
  description: string
  price: string
  discount_active: boolean
  discount_price: string
  visual_rating: string
  category_id: string
  available: boolean
}

function fitsDecimalPlaces(value: number, places: number) {
  // Validate the decimal representation JSON sends, not a binary multiplication
  // such as 1.1 * 100, which can incorrectly reject valid decimal amounts.
  const [coefficient, exponent = '0'] = String(value).split('e')
  return (coefficient.split('.')[1]?.length ?? 0) - Number(exponent) <= places
}

export function parseProductForm(
  form: ProductFormState,
  categories: Pick<Category, 'id' | 'store_id'>[],
  storeId: number,
): { value: ProductCreationInput } | { error: string } {
  const name = form.name.trim()
  const description = form.description.trim()
  const price = Number(form.price)
  const discountPrice = form.discount_price ? Number(form.discount_price) : null
  const visualRating = Number(form.visual_rating)

  if (!name || [...name].length > 120) {
    return { error: 'Ingresa un nombre de entre 1 y 120 caracteres.' }
  }
  if ([...description].length > 500) {
    return { error: 'La descripcion debe tener como maximo 500 caracteres.' }
  }
  if (!form.price.trim() || !Number.isFinite(price) || price < 0) {
    return { error: 'Ingresa un precio valido mayor o igual a cero.' }
  }
  if (typeof form.discount_active !== 'boolean' || typeof form.available !== 'boolean') {
    return { error: 'El estado del producto no es valido.' }
  }
  if (form.discount_active && discountPrice === null) {
    return { error: 'Ingresa un precio promocional mayor que cero.' }
  }
  if (discountPrice !== null && (!Number.isFinite(discountPrice)
    || discountPrice <= 0 || discountPrice >= price)) {
    return { error: 'El precio promocional debe ser mayor que cero y menor que el precio original.' }
  }
  if (discountPrice !== null && (discountPrice > 99999999.99 || !fitsDecimalPlaces(discountPrice, 2))) {
    return { error: 'El precio promocional admite hasta 99999999.99 y dos decimales.' }
  }
  if (!Number.isFinite(visualRating) || visualRating < 0 || visualRating > 5) {
    return { error: 'La calificacion visual debe estar entre 0 y 5.' }
  }
  const categoryId = form.category_id || null
  if (categoryId !== null && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(categoryId)
    || !categories.some((category) => category.id.toLowerCase() === categoryId.toLowerCase()
      && category.store_id === storeId))) {
    return { error: 'Selecciona una categoria de esta tienda.' }
  }
  return {
    value: {
      name, description, price, discount_active: form.discount_active,
      discount_price: discountPrice,
      // Preserve the existing form's one-decimal normalization.
      visual_rating: Math.round(visualRating * 10) / 10,
      category_id: categoryId, available: form.available,
    },
  }
}
