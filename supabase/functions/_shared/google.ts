import { importPKCS8, SignJWT } from "npm:jose@5";

// ---------------------------------------------------------------------------
//  Acesso à Google Play Developer API usando a Service Account
//  (variável de ambiente GOOGLE_SERVICE_ACCOUNT = JSON completo da conta).
// ---------------------------------------------------------------------------

type ServiceAccount = { client_email: string; private_key: string; project_id?: string };

export type GoogleSub = {
  subscriptionState?: string;
  acknowledgementState?: string;
  lineItems?: Array<{ expiryTime?: string; productId?: string }>;
};

let cache: { token: string; exp: number } | null = null;

function serviceAccount(): ServiceAccount {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT");
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT não configurado");
  return JSON.parse(raw) as ServiceAccount;
}

export async function googleAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cache && cache.exp - 60 > now) return cache.token;

  const sa = serviceAccount();
  const key = await importPKCS8(sa.private_key, "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/androidpublisher" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error("Google token: " + text);
  const data = JSON.parse(text) as { access_token: string; expires_in?: number };
  cache = { token: data.access_token, exp: now + (data.expires_in ?? 3600) };
  return data.access_token;
}

export async function getGoogleSubscription(packageName: string, token: string): Promise<GoogleSub> {
  const access = await googleAccessToken();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}` +
    `/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
  const text = await res.text();
  if (!res.ok) throw new Error("Google verify: " + text);
  return JSON.parse(text) as GoogleSub;
}

export function mapGoogleStatus(state?: string): string {
  switch (state) {
    case "SUBSCRIPTION_STATE_ACTIVE":
      return "active";
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
    case "SUBSCRIPTION_STATE_CANCELED":
      // Cancelado, mas ainda dá acesso até a data de expiração.
      return "active";
    case "SUBSCRIPTION_STATE_ON_HOLD":
      return "past_due";
    case "SUBSCRIPTION_STATE_PAUSED":
      return "paused";
    case "SUBSCRIPTION_STATE_EXPIRED":
      return "expired";
    case "SUBSCRIPTION_STATE_PENDING":
      return "incomplete";
    default:
      return "incomplete";
  }
}

export function googlePeriodEnd(sub: GoogleSub): string | null {
  const times = (sub.lineItems ?? [])
    .map((li) => li.expiryTime)
    .filter((t): t is string => !!t)
    .map((t) => new Date(t).getTime());
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

export function googleProductId(sub: GoogleSub): string | null {
  return sub.lineItems?.[0]?.productId ?? null;
}
