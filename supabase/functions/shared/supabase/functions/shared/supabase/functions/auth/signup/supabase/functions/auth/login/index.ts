// ============================================================
// POST /auth/login
// ============================================================

import { supabase } from '../../shared/supabase.ts'
import { APIResponse } from '../../shared/types.ts'

interface LoginRequest {
    email: string
    password: string
}

export async function POST(req: Request): Promise<Response> {
    try {
        const body: LoginRequest = await req.json()

        if (!body.email || !body.password) {
            return Response.json({
                success: false,
                error: 'Email and password are required'
            } as APIResponse, { status: 400 })
        }

        const { data, error } = await supabase.auth.signInWithPassword({
            email: body.email,
            password: body.password
        })

        if (error) {
            return Response.json({
                success: false,
                error: error.message
            } as APIResponse, { status: 401 })
        }

        return Response.json({
            success: true,
            data: {
                session: data.session,
                user: data.user
            }
        } as APIResponse)

    } catch (error) {
        console.error('Login error:', error)
        return Response.json({
            success: false,
            error: 'Internal server error'
        } as APIResponse, { status: 500 })
    }
}
