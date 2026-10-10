import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Cliente com service_role: ignora RLS. Use SÓ no servidor (Edge Functions).
export function admin(): ReturnType<typeof createClient> {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

// Cliente que age em nome do usuário que chamou (usa o JWT do header).
export function userClient(authHeader: string | null) {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: authHeader ?? "" } },
      auth: { persistSession: false },
    },
  );
}
