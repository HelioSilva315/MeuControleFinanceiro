import { admin } from "../_shared/supabase.ts";
import { upsertSubscription } from "../_shared/store.ts";
import {
  getGoogleSubscription,
  googlePeriodEnd,
  googleProductId,
  mapGoogleStatus,
} from "../_shared/google.ts";

// Endpoint consumido pelo Pub/Sub (Real-time Developer Notifications).
// Configure uma assinatura push do Pub/Sub apontando para esta função.
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  try {
    const body = await req.json().catch(() => ({}));
    const dataB64 = body?.message?.data as string | undefined;
    if (!dataB64) return new Response("sem dados", { status: 200 });

    const decoded = JSON.parse(atob(dataB64));
    const notification = decoded?.subscriptionNotification ?? {};
    const purchaseToken = notification?.purchaseToken as string | undefined;
    const packageName = (decoded?.packageName as string) || Deno.env.get("GOOGLE_PACKAGE_NAME");
    if (!purchaseToken || !packageName) return new Response("ignorado", { status: 200 });

    const db = admin();
    const { data: existing } = await db
      .from("subscriptions")
      .select("household_id")
      .eq("provider", "google")
      .eq("external_id", purchaseToken)
      .maybeSingle();
    if (!existing?.household_id) return new Response("assinatura desconhecida", { status: 200 });

    const gsub = await getGoogleSubscription(packageName, purchaseToken);
    await upsertSubscription(db, {
      household_id: existing.household_id,
      provider: "google",
      store: "play",
      external_id: purchaseToken,
      product_id: googleProductId(gsub),
      status: mapGoogleStatus(gsub.subscriptionState),
      current_period_end: googlePeriodEnd(gsub),
      raw: gsub,
    });

    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("rtdn", e);
    return new Response("erro", { status: 500 });
  }
});
