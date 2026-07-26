// ============================================================
// PUT /businesses/update
// ============================================================

import { supabase } from '../../shared/supabase.ts'
import { requireMaster } from '../../shared/auth.ts'
import { APIResponse } from '../../shared/types.ts'

interface UpdateBusinessRequest {
    name?: string
    business_type?: string
    country?: string
    currency?: string
    tax_name?: string
    tax_percent?: number
    logo_data_url?: string
}

export async function PUT(req: Request): Promise<Response> {
    try {
        const { businessId } = await requireMaster(req)
        const body: UpdateBusinessRequest = await req.json()

        const { data, error } = await supabase
            .from('businesses')
            .update(body)
            .eq('id', businessId)
            .select()
            .single()

        if (error) {
            return Response.json({
                success: false,
                error: error.message
            } as APIResponse, { status: 400 })
        }

        return Response.json({
            success: true,
            data,
            message: 'Business updated successfully'
        } as APIResponse)

    } catch (error) {
        console.error('Update business error:', error)
        return Response.json({
            success: false,
            error: error.message || 'Internal server error'
        } as APIResponse, { status: 500 })
    }
}
