import Stripe from "npm:stripe@17";
import { admin } from "../_shared/supabase.ts";
import { upsertSubscription } from "../_shared/store.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function periodEnd(sub: any): string | null {
  const fromItems = (sub.items?.data ?? [])
    .map((i: any) => i.current_period_end)
    .filter((n: number) => typeof n === "number");
  const secs = fromItems.length ? Math.max(...fromItems) : sub.current_period_end;
  return secs ? new Date(secs * 1000).toISOString() : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function persist(sub: any): Promise<void> {
  const houseId = (sub.metadata?.household_id as string) || null;
  if (!houseId) {
    console.warn("stripe: assinatura sem household_id no metadata", sub.id);
    return;
  }
  await upsertSubscription(admin(), {
    household_id: houseId,
    provider: "stripe",
    store: "web",
    external_id: sub.id,
    product_id: sub.items?.data?.[0]?.price?.product ?? null,
    price_id: sub.items?.data?.[0]?.price?.id ?? null,
    status: sub.status,
    current_period_end: periodEnd(sub),
    raw: sub,
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig ?? "",
      Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "",
      undefined,
      cryptoProvider,
    );
  } catch (e) {
    return new Response(`Webhook inválido: ${e}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = event.data.object as any;
        const subId = session.subscription as string | null;
        if (subId) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sub: any = await stripe.subscriptions.retrieve(subId);
          if (!sub.metadata?.household_id && session.metadata?.household_id) {
            sub.metadata = { ...sub.metadata, household_id: session.metadata.household_id };
            await stripe.subscriptions.update(subId, { metadata: sub.metadata });
          }
          await persist(sub);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await persist(event.data.object);
        break;
      default:
        break;
    }
  } catch (e) {
    console.error("stripe handler", e);
    return new Response("erro no processamento", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
});
