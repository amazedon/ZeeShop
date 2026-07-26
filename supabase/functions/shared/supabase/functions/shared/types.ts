// ============================================================
// SHARED TYPES
// ============================================================

export interface APIResponse<T = any> {
    success: boolean
    data?: T
    error?: string
    message?: string
}

export interface Business {
    id: string
    name: string
    business_type?: string
    country?: string
    currency?: string
    subscription_plan: string
    created_at: string
}

export interface User {
    id: string
    business_id: string
    username: string
    email: string
    first_name: string
    last_name: string
    role: 'master' | 'staff' | 'viewer'
    is_active: boolean
    can_sell: boolean
    can_sell_credit: boolean
    can_record_cash: boolean
    can_add_goods: boolean
    can_void_return: boolean
    created_at: string
}

export interface Shop {
    id: string
    business_id: string
    name: string
    address?: string
    phone?: string
    email?: string
    receipt_footer?: string
    receipt_terms?: string
    created_at: string
}

export interface Good {
    id: string
    shop_id: string
    name: string
    base_price: number
    cost_price: number
    emoji: string
    barcode?: string
    reorder_level: number
    has_variants: boolean
    spec?: string
    dimension?: any
    created_at: string
}

export interface Batch {
    id: string
    good_id: string
    qty_remaining: number
    expiry_date: string
    cost_price: number
    batch_no: string
    auction_active: boolean
    auction_price?: number
    auction_discount?: number
    created_at: string
}

export interface Variant {
    id: string
    good_id: string
    size?: string
    color?: string
    qty: number
    label: string
    created_at: string
}

export interface Customer {
    id: string
    business_id: string
    full_name: string
    phone_e164?: string
    whatsapp_number?: string
    email?: string
    group_id?: string
    notes?: string
    created_at: string
}

export interface Sale {
    id: string
    shop_id: string
    customer_id?: string
    walk_in_name?: string
    walk_in_phone?: string
    date: string
    subtotal: number
    paid_amount: number
    balance: number
    due_date?: string
    status: 'paid' | 'partial' | 'credit' | 'voided'
    items: SaleItem[]
    created_at: string
}

export interface SaleItem {
    id: string
    sale_id: string
    good_id: string
    batch_id?: string
    variant_id?: string
    variant_label?: string
    qty: number
    returned_qty: number
    price_used: number
    note?: string
    created_at: string
}

export interface Expense {
    id: string
    business_id: string
    shop_id: string
    category: string
    description?: string
    amount: number
    date: string
    created_at: string
}

export interface Supplier {
    id: string
    business_id: string
    name: string
    country?: string
    phone?: string
    supplies_what?: string
    notes?: string
    created_at: string
}

export interface SupplierPurchase {
    id: string
    supplier_id: string
    shop_id: string
    good_id: string
    item_name: string
    qty: number
    cost_price: number
    total_amount: number
    paid_amount: number
    balance: number
    date: string
    created_at: string
}

export interface SubscriptionPlan {
    id: string
    name: string
    slug: string
    description?: string
    price_monthly: number
    price_yearly: number
    currency: string
    features: any
    max_shops: number
    max_goods: number
    max_staff: number
    max_customers: number
    has_reports: boolean
    has_backup: boolean
    has_priority_support: boolean
    has_advanced_analytics: boolean
    is_active: boolean
    sort_order: number
    created_at: string
}

export interface Subscription {
    id: string
    business_id: string
    plan_id: string
    status: 'active' | 'past_due' | 'canceled' | 'expired' | 'trial'
    current_period_start: string
    current_period_end: string
    canceled_at?: string
    ended_at?: string
    provider?: string
    provider_subscription_id?: string
    provider_customer_id?: string
    payment_method?: string
    notes?: string
    created_at: string
}
