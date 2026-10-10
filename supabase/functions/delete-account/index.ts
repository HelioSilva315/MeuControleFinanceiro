import { json, preflight } from "../_shared/http.ts";
import { admin, userClient } from "../_shared/supabase.ts";

// POST /functions/v1/delete-account
// Cabeçalho: Authorization: Bearer <jwt do usuário>
// Exclui a conta do usuário e os dados vinculados (LGPD / Google Play).
//
// Regra de segurança: se o usuário for DONO de um casal que ainda tem outro
// membro (ex.: o cônjuge), transferimos a titularidade para esse membro em vez
// de apagar a família inteira. Se for o único membro, a família é removida em
// cascata (households -> subscriptions/cloud_backups/household_members).
Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const sb = userClient(req.headers.get("Authorization"));
    const { data: { user }, error } = await sb.auth.getUser();
    if (error || !user) return json({ ok: false, error: "unauthorized" }, 401);

    const adm = admin();

    // Transfere a titularidade dos casais compartilhados antes de excluir.
    const { data: owned } = await adm
      .from("households")
      .select("id")
      .eq("owner_id", user.id);

    for (const h of owned ?? []) {
      const { data: others } = await adm
        .from("household_members")
        .select("user_id")
        .eq("household_id", h.id)
        .neq("user_id", user.id)
        .limit(1);

      const next = others?.[0]?.user_id;
      if (next) {
        await adm.from("households").update({ owner_id: next }).eq("id", h.id);
        await adm
          .from("household_members")
          .update({ role: "owner" })
          .eq("household_id", h.id)
          .eq("user_id", next);
      }
    }

    const { error: delErr } = await adm.auth.admin.deleteUser(user.id);
    if (delErr) return json({ ok: false, error: delErr.message }, 500);

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
