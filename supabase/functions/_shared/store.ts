import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type SubInput = {
  household_id: string;
  provider: "stripe" | "google";
  store: "web" | "play";
  external_id: string;
  product_id?: string | null;
  price_id?: string | null;
  status: string;
  current_period_end?: string | null;
  raw?: unknown;
};

export async function upsertSubscription(admin: SupabaseClient, sub: SubInput): Promise<void> {
  const { error } = await admin
    .from("subscriptions")
    .upsert({ ...sub, updated_at: new Date().toISOString() }, { onConflict: "provider,external_id" });
  if (error) throw error;
}

export async function householdForUser(admin: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await admin
    .from("household_members")
    .select("household_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data?.household_id as string) ?? null;
}

export async function ensureHousehold(admin: SupabaseClient, userId: string, name = "Nosso Caixa"): Promise<string> {
  const existing = await householdForUser(admin, userId);
  if (existing) return existing;
  const { data, error } = await admin
    .from("households")
    .insert({ owner_id: userId, name })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}
