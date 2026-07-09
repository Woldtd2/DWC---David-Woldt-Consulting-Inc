// Supabase Edge Function: ls-webhook
// Lemon Squeezy purchase webhook for SoloLaunch. Verifies signature, idempotently records
// the order, maps the purchased variant -> vertical, grants subscription entitlements, and
// (if the checkout passed intake fields in custom_data) creates the intake and fires
// generate-kit so the buyer's Word/Excel kit is produced automatically.
//
// Deploy:  supabase functions deploy ls-webhook  (verify_jwt=false — LS signs with HMAC)
// Secrets: LEMONSQUEEZY_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GENERATE_SECRET
// LS setup: Settings -> Webhooks -> callback = https://<project>.functions.supabase.co/ls-webhook
//           signing secret = LEMONSQUEEZY_WEBHOOK_SECRET; events: order_created, subscription_*.
//
// Assumptions to verify against your LS config: variant_id lives at
// data.attributes.first_order_item.variant_id (orders) / data.attributes.variant_id (subs);
// optional buyer intake arrives in meta.custom_data. Adjust field paths if your setup differs.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";

async function verifyLS(raw: string, sig: string, secret: string): Promise<boolean> {
  if (!secret || !sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== sig.length) return false;
  let d = 0; for (let i = 0; i < hex.length; i++) d |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  const raw = await req.text();
  const sig = req.headers.get("X-Signature") ?? "";
  if (!(await verifyLS(raw, sig, env("LEMONSQUEEZY_WEBHOOK_SECRET"))))
    return new Response("bad signature", { status: 401 });

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  const event = payload?.meta?.event_name ?? "unknown";
  const data = payload?.data ?? {};
  const attrs = data?.attributes ?? {};
  const eventId = String(payload?.meta?.webhook_id ?? `${event}:${data?.id ?? ""}`);

  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  // Idempotency: skip if we've already processed this event.
  const { error: dupErr } = await sb.from("processed_webhooks")
    .insert({ event_id: eventId, event_name: event });
  if (dupErr) return Response.json({ ok: true, deduped: true }); // unique-violation => already handled

  try {
    if (event === "order_created") {
      const item = attrs.first_order_item ?? {};
      const variantId = String(item.variant_id ?? attrs.variant_id ?? "");

      // Map the purchased variant -> vertical via verticals.pricing.ls_products[].ref.
      const { data: verticals } = await sb.from("verticals").select("id, slug, pricing");
      let vertical: any = null, prodEntry: any = null;
      for (const v of verticals ?? []) {
        const hit = (v.pricing?.ls_products ?? []).find((p: any) => String(p.ref) === variantId);
        if (hit) { vertical = v; prodEntry = hit; break; }
      }
      // orders.product is constrained to 'kit' | 'business_os' (type, not name); vertical_id says which.
      const product = (prodEntry?.type === "subscription" || prodEntry?.sku === "business_os") ? "business_os" : "kit";

      const { data: order } = await sb.from("orders").insert({
        ls_order_id: String(data.id), email: attrs.user_email ?? null,
        product,
        amount_cents: attrs.total ?? null, currency: attrs.currency ?? "USD",
        payment_method: "lemonsqueezy", status: "paid",
        vertical_id: vertical?.id ?? null, raw: payload,
      }).select("id").single();

      // If the checkout collected intake fields, create the intake and generate now.
      const cd = payload?.meta?.custom_data ?? {};
      const hasIntake = vertical && (cd.idea || cd.business_name || cd.topic || cd.target_role || cd.brand_name);
      if (order && hasIntake) {
        const { data: intake } = await sb.from("intakes").insert({
          order_id: order.id, vertical_id: vertical!.id,
          business_name: cd.business_name ?? null, idea: cd.idea ?? cd.topic ?? cd.target_role ?? cd.brand_name ?? null,
          audience: cd.target_customer ?? cd.audience ?? cd.target_reader ?? cd.target_audience ?? null,
          primary_goal: cd.primary_goal ?? cd.monthly_goal ?? null,
          category: cd.category ?? null, tone: cd.tone ?? null, extra: cd,
        }).select("id").single();

        if (intake) {
          // fire-and-forget generation (best effort)
          fetch(`${env("SUPABASE_URL")}/functions/v1/generate-kit`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Generate-Secret": env("GENERATE_SECRET") },
            body: JSON.stringify({ intake_id: intake.id }),
          }).catch(() => {});
        }
      }
      return Response.json({ ok: true, recorded: "order", generating: !!hasIntake });
    }

    if (event.startsWith("subscription_")) {
      // Grant/refresh the entitlement when we can resolve a user (custom_data.user_id).
      const userId = payload?.meta?.custom_data?.user_id ?? null;
      if (userId) {
        await sb.from("entitlements").upsert({
          user_id: userId, plan: "business_os", status: attrs.status ?? "active",
          ls_subscription_id: String(data.id), current_period_end: attrs.renews_at ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
      }
      return Response.json({ ok: true, recorded: "subscription", entitlement: !!userId });
    }

    return Response.json({ ok: true, ignored: event });
  } catch (e) {
    // Allow LS to retry by returning 500; the processed_webhooks row is removed so retry re-runs.
    await sb.from("processed_webhooks").delete().eq("event_id", eventId);
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
