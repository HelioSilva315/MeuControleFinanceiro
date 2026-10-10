import { json, preflight } from "../_shared/http.ts";
import { userClient } from "../_shared/supabase.ts";

// GET/POST /functions/v1/entitlement
// Cabeçalho: Authorization: Bearer <jwt do usuário>
// Resposta: { premium: boolean, household_id: uuid|null, until: ISO|null, subscriptions: [...] }
Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const sb = userClient(req.headers.get("Authorization"));
    const { data: { user }, error } = await sb.auth.getUser();
    if (error || !user) return json({ premium: false, error: "unauthorized" }, 401);

    // Garante que o usuário tem um household (o "casal").
    let { data: householdId } = await sb.rpc("my_household");
    if (!householdId) {
      const { data: created, error: insErr } = await sb
        .from("households")
        .insert({ owner_id: user.id })
        .select("id")
        .single();
      if (insErr) return json({ premium: false, household_id: null, error: insErr.message }, 500);
      householdId = created?.id ?? null;
    }

    const { data: premium } = await sb.rpc("i_am_premium");
    const { data: subs } = await sb
      .from("subscriptions")
      .select("provider, store, status, current_period_end")
      .in("status", ["active", "trialing", "past_due"])
      .order("current_period_end", { ascending: false });

    const until = (subs ?? [])
      .map((s: { current_period_end: string | null }) => s.current_period_end)
      .filter(Boolean)
      .sort()
      .pop() ?? null;

    return json({ premium: !!premium, household_id: householdId, until, subscriptions: subs ?? [] });
  } catch (e) {
    return json({ premium: false, household_id: null, error: String(e) }, 500);
  }
});
