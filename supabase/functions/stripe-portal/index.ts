import Stripe from "npm:stripe@17";
import { json, preflight } from "../_shared/http.ts";
import { admin, userClient } from "../_shared/supabase.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
});

// POST /functions/v1/stripe-portal
// Cabeçalho: Authorization: Bearer <jwt do usuário>
// Body: { returnUrl?: string }
// Resposta: { url: string } — URL do portal do cliente Stripe (cancelar/trocar/fatura)
Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const sb = userClient(req.headers.get("Authorization"));
    const { data: { user }, error } = await sb.auth.getUser();
    if (error || !user) return json({ ok: false, error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const adm = admin();

    const { data: memberships } = await adm
      .from("household_members")
      .select("household_id")
      .eq("user_id", user.id);
    const householdIds = (memberships ?? []).map((m: { household_id: string }) => m.household_id);
    if (!householdIds.length) return json({ ok: false, error: "sem_household" }, 404);

    const { data: sub } = await adm
      .from("subscriptions")
      .select("external_id")
      .eq("provider", "stripe")
      .in("household_id", householdIds)
      .in("status", ["active", "trialing", "past_due"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sub?.external_id) {
      return json({ ok: false, error: "sem_assinatura_stripe" }, 404);
    }

    const subscription = await stripe.subscriptions.retrieve(sub.external_id);
    const customerId = typeof subscription.customer === "string"
      ? subscription.customer
      : (subscription.customer as { id: string } | null)?.id;
    if (!customerId) return json({ ok: false, error: "sem_cliente" }, 404);

    const base = (Deno.env.get("APP_URL") || body?.returnUrl || "").replace(/\/+$/, "");
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: base || undefined,
    });

    return json({ ok: true, url: portal.url });
  } catch (e) {
    console.error("stripe-portal", e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
