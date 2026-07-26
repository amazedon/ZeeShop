// ============================================================
// POST /auth/logout
// ============================================================

import { supabase } from '../../shared/supabase.ts'
import { APIResponse } from '../../shared/types.ts'

export async function POST(req: Request): Promise<Response> {
    try {
        const { error } = await supabase.auth.signOut()

        if (error) {
            return Response.json({
                success: false,
                error: error.message
            } as APIResponse, { status: 400 })
        }

        return Response.json({
            success: true,
            message: 'Logged out successfully'
        } as APIResponse)

    } catch (error) {
        console.error('Logout error:', error)
        return Response.json({
            success: false,
            error: 'Internal server error'
        } as APIResponse, { status: 500 })
    }
}
