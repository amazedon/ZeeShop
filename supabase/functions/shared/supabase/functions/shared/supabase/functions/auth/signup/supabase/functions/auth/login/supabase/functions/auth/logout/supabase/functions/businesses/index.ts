// ============================================================
// GET /businesses
// ============================================================

import { supabase } from '../shared/supabase.ts'
import { requireAuth } from '../shared/auth.ts'
import { APIResponse } from '../shared/types.ts'

export async function GET(req: Request): Promise<Response> {
    try {
        const user = await requireAuth(req)

        const { data, error } = await supabase
            .from('businesses')
            .select('*')
            .eq('id', user.business_id)
            .single()

        if (error) {
            return Response.json({
                success: false,
                error: error.message
            } as APIResponse, { status: 404 })
        }

        return Response.json({
            success: true,
            data
        } as APIResponse)

    } catch (error) {
        console.error('Get business error:', error)
        return Response.json({
            success: false,
            error: error.message || 'Internal server error'
        } as APIResponse, { status: 500 })
    }
}
