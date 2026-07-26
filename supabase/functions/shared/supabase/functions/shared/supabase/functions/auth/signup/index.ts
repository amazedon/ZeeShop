// ============================================================
// POST /auth/signup
// ============================================================

import { supabase } from '../../shared/supabase.ts'
import { APIResponse } from '../../shared/types.ts'

interface SignupRequest {
    email: string
    password: string
    username: string
    business_name: string
    first_name: string
    last_name: string
    phone?: string
    country?: string
    currency?: string
}

export async function POST(req: Request): Promise<Response> {
    try {
        const body: SignupRequest = await req.json()

        // Validate
        if (!body.email || !body.password || !body.username || !body.business_name || !body.first_name || !body.last_name) {
            return Response.json({
                success: false,
                error: 'All fields are required'
            } as APIResponse, { status: 400 })
        }

        // Check username uniqueness
        const { data: existingUser } = await supabase
            .from('users')
            .select('id')
            .eq('username', body.username)
            .single()

        if (existingUser) {
            return Response.json({
                success: false,
                error: 'Username already taken'
            } as APIResponse, { status: 400 })
        }

        // Create auth user
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email: body.email,
            password: body.password,
            options: {
                data: {
                    first_name: body.first_name,
                    last_name: body.last_name,
                    business_name: body.business_name
                }
            }
        })

        if (authError) {
            return Response.json({
                success: false,
                error: authError.message
            } as APIResponse, { status: 400 })
        }

        const userId = authData.user!.id
        const bizId = 'biz_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
        const shopId = 'shop_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

        // Create business
        await supabase
            .from('businesses')
            .insert({
                id: bizId,
                name: body.business_name,
                country: body.country || 'Nigeria',
                currency: body.currency || 'NGN',
                subscription_plan: 'free'
            })

        // Create user
        await supabase
            .from('users')
            .insert({
                id: userId,
                business_id: bizId,
                username: body.username,
                email: body.email,
                first_name: body.first_name,
                last_name: body.last_name,
                phone: body.phone || '',
                role: 'master',
                is_active: true,
                can_add_goods: true,
                can_sell: true,
                can_sell_credit: true,
                can_record_cash: true
            })

        // Create shop
        await supabase
            .from('shops')
            .insert({
                id: shopId,
                business_id: bizId,
                name: body.business_name + ' — Main Shop',
                receipt_footer: 'Thank you for your business!',
                receipt_terms: 'Goods sold in good condition. No refund after payment.',
                auction_discount_default: 30
            })

        return Response.json({
            success: true,
            data: {
                user: authData.user,
                business_id: bizId,
                shop_id: shopId
            },
            message: 'Business created successfully!'
        } as APIResponse, { status: 201 })

    } catch (error) {
        console.error('Signup error:', error)
        return Response.json({
            success: false,
            error: 'Internal server error'
        } as APIResponse, { status: 500 })
    }
}
