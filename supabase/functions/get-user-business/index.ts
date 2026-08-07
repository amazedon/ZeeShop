// 1. Get the current logged-in user's Auth ID
const authUserId = authUser.user.id; // or supabase.auth.getUser()

// 2. Look up the app_users table first to find their linked business
const { data: appUser, error: appUserErr } = await supabase
  .from("app_users")
  .select("business_id, role, is_active")
  .eq("auth_user_id", authUserId)
  .single();

// 3. If no record is found here, THEN show your error message
if (appUserErr || !appUser) {
  return json({ error: "We couldn't find a business linked to this account." }, 404);
}

// 4. Fetch the business details using the business_id found in app_users
const { data: business, error: bizErr } = await supabase
  .from("businesses")
  .select("*")
  .eq("id", appUser.business_id)
  .single();

// 5. Fetch the shops associated with this business
const { data: shops } = await supabase
  .from("shops")
  .select("*")
  .eq("business_id", appUser.business_id);

// Return the fully loaded data to the app
return json({
  success: true,
  user: appUser,
  business: business,
  shops: shops || []
}, 200);
