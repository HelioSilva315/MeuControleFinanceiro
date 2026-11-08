import Stripe from "npm:stripe@17";
import { json, preflight } from "../_shared/http.ts";
import { admin, ensureHousehold, userClient } from "../_shared/supabase.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
});

// POST /functions/v1/stripe-checkout
// Cabeçalho: Authorization: Bearer <jwt do usuário>
// Body: { cycle: "monthly" | "annual", returnUrl?: string }
// Resposta: { url: string } — URL do Stripe Checkout (7 dias grátis)
Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const sb = userClient(req.headers.get("Authorization"));
    const { data: { user }, error } = await sb.auth.getUser();
    if (error || !user) return json({ ok: false, error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const cycle = body?.cycle === "annual" ? "annual" : "monthly";

    const priceId = cycle === "annual"
      ? (Deno.env.get("STRIPE_PRICE_YEARLY_ID") || Deno.env.get("STRIPE_PRICE_ID") || "")
      : (Deno.env.get("STRIPE_PRICE_MONTHLY_ID") || Deno.env.get("STRIPE_PRICE_ID") || "");
    if (!priceId) {
      return json({ ok: false, error: "preco_nao_configurado" }, 500);
    }

    const householdId = await ensureHousehold(admin(), user.id);

    const base = (Deno.env.get("APP_URL") || body?.returnUrl || "").replace(/\/+$/, "");
    if (!base) {
      return json({ ok: false, error: "app_url_nao_configurado" }, 500);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/?checkout=success`,
      cancel_url: `${base}/?checkout=cancel`,
      client_reference_id: householdId,
      customer_email: user.email ?? undefined,
      allow_promotion_codes: true,
      metadata: { household_id: householdId, cycle },
      subscription_data: {
        trial_period_days: 7,
        metadata: { household_id: householdId, cycle },
      },
    });

    return json({ ok: true, url: session.url });
  } catch (e) {
    console.error("stripe-checkout", e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
