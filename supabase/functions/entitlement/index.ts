import { json, preflight } from "../_shared/http.ts";
import { userClient } from "../_shared/supabase.ts";

// GET/POST /functions/v1/entitlement
// Cabeçalho: Authorization: Bearer <jwt do usuário>
// Resposta: { premium: boolean, until: ISO|null, subscriptions: [...] }
Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const sb = userClient(req.headers.get("Authorization"));
    const { data: { user }, error } = await sb.auth.getUser();
    if (error || !user) return json({ premium: false, error: "unauthorized" }, 401);

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

    return json({ premium: !!premium, until, subscriptions: subs ?? [] });
  } catch (e) {
    return json({ premium: false, error: String(e) }, 500);
  }
});
