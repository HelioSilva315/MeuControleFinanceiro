import { json, preflight } from "../_shared/http.ts";
import { admin, userClient } from "../_shared/supabase.ts";
import { ensureHousehold, upsertSubscription } from "../_shared/store.ts";
import {
  getGoogleSubscription,
  googlePeriodEnd,
  googleProductId,
  mapGoogleStatus,
} from "../_shared/google.ts";

// POST /functions/v1/google-play-verify
// Cabeçalho: Authorization: Bearer <jwt do usuário>
// Corpo: { purchaseToken, subscriptionId, productId }
// Valida a compra na Google Play e grava o premium para o household do usuário.
Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "method" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const purchaseToken = body?.purchaseToken as string | undefined;
    const subscriptionId = body?.subscriptionId as string | undefined;
    const productId = body?.productId as string | undefined;
    if (!purchaseToken) return json({ error: "purchaseToken obrigatório" }, 400);

    const sb = userClient(req.headers.get("Authorization"));
    const { data: { user }, error } = await sb.auth.getUser();
    if (error || !user) return json({ error: "unauthorized" }, 401);

    const db = admin();
    const householdId = await ensureHousehold(db, user.id);
    const packageName = Deno.env.get("GOOGLE_PACKAGE_NAME");
    if (!packageName) return json({ error: "GOOGLE_PACKAGE_NAME não configurado" }, 500);

    const gsub = await getGoogleSubscription(packageName, purchaseToken);
    const status = mapGoogleStatus(gsub.subscriptionState);

    await upsertSubscription(db, {
      household_id: householdId,
      provider: "google",
      store: "play",
      external_id: purchaseToken,
      product_id: productId ?? googleProductId(gsub) ?? subscriptionId ?? null,
      price_id: subscriptionId ?? null,
      status,
      current_period_end: googlePeriodEnd(gsub),
      raw: gsub,
    });

    return json({ ok: true, status, premium: status === "active" });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
