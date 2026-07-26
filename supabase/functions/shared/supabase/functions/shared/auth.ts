// ============================================================
// AUTHENTICATION HELPERS
// ============================================================

import { supabase } from './supabase.ts'

export async function getAuthenticatedUser(req: Request) {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null
    }

    const token = authHeader.split(' ')[1]
    const { data: { user }, error } = await supabase.auth.getUser(token)
    
    if (error || !user) {
        return null
    }

    return user
}

export async function requireAuth(req: Request) {
    const user = await getAuthenticatedUser(req)
    if (!user) {
        throw new Error('Unauthorized')
    }
    return user
}

export async function requireMaster(req: Request) {
    const user = await requireAuth(req)
    
    const { data, error } = await supabase
        .from('users')
        .select('role, business_id')
        .eq('id', user.id)
        .single()
    
    if (error || !data || data.role !== 'master') {
        throw new Error('Forbidden: Master access required')
    }
    
    return { user, businessId: data.business_id }
}
