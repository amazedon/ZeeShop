// ============================================================
// GET /businesses/limits
// ============================================================

import { supabase } from '../../shared/supabase.ts'
import { requireAuth } from '../../shared/auth.ts'
import { APIResponse } from '../../shared/types.ts'

export async function GET(req: Request): Promise<Response> {
    try {
        const user = await requireAuth(req)

        // Get subscription limits
        const { data: limits, error } = await supabase
            .rpc('get_business_limits', {
                p_business_id: user.business_id
            })

        if (error) {
            return Response.json({
                success: false,
                error: error.message
            } as APIResponse, { status: 400 })
        }

        // Get current counts
        const [shopsCount, goodsCount, staffCount, customersCount] = await Promise.all([
            supabase.from('shops').select('id', { count: 'exact', head: true }).eq('business_id', user.business_id),
            supabase.from('goods').select('id', { count: 'exact', head: true }).eq('shop_id', user.business_id),
            supabase.from('users').select('id', { count: 'exact', head: true }).eq('business_id', user.business_id).neq('role', 'master'),
            supabase.from('customers').select('id', { count: 'exact', head: true }).eq('business_id', user.business_id)
        ])

        return Response.json({
            success: true,
            data: {
                ...limits,
                current_shops: shopsCount.count || 0,
                current_goods: goodsCount.count || 0,
                current_staff: staffCount.count || 0,
                current_customers: customersCount.count || 0
            }
        } as APIResponse)

    } catch (error) {
        console.error('Get limits error:', error)
        return Response.json({
            success: false,
            error: error.message || 'Internal server error'
        } as APIResponse, { status: 500 })
    }
}
