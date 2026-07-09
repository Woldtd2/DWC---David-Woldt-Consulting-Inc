// Supabase Edge Function: intake-submit
// Post-purchase intake handler for SoloLaunch. The buyer's browser submits their intake
// form after checkout; this verifies the paid order, creates the intake (idempotent per
// order), and triggers generate-kit. Works whether or not the checkout passed custom_data.
//
// Deploy:  supabase functions deploy intake-submit  (verify_jwt=false — buyer-facing)
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GENERATE_SECRET
// Invoke:  POST { "ls_order_id": "...", "email": "...", "fields": { ... } }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const J = (b: unknown, s = 200) => Response.json(b, { status: s, headers: cors });

  const { ls_order_id, email, fields } = await req.json().catch(() => ({}));
  if (!ls_order_id || !email) return J({ error: "ls_order_id and email required" }, 400);

  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  // Verify a paid order matching this id + email (case-insensitive).
  const { data: order } = await sb.from("orders")
    .select("id, user_id, vertical_id, email, status")
    .eq("ls_order_id", String(ls_order_id)).maybeSingle();
  if (!order || order.status !== "paid" || (order.email ?? "").toLowerCase() !== String(email).toLowerCase())
    return J({ error: "no matching paid order" }, 401);
  if (!order.vertical_id) return J({ error: "order has no vertical" }, 409);

  // Idempotent: one intake per order.
  const { data: existing } = await sb.from("intakes").select("id").eq("order_id", order.id).maybeSingle();
  if (existing) return J({ intake_id: existing.id, status: "already_submitted" });

  const f = fields ?? {};
  const { data: intake, error: iErr } = await sb.from("intakes").insert({
    order_id: order.id, user_id: order.user_id ?? null, vertical_id: order.vertical_id,
    business_name: f.business_name ?? null,
    idea: f.idea ?? f.topic ?? f.target_role ?? f.brand_name ?? null,
    audience: f.target_customer ?? f.audience ?? f.target_reader ?? f.target_audience ?? null,
    primary_goal: f.primary_goal ?? f.monthly_goal ?? null,
    category: f.category ?? null, tone: f.tone ?? null, extra: f,
  }).select("id").single();
  if (iErr) return J({ error: iErr.message }, 500);

  // Trigger generation (best effort; the kit lands in the 'kits' bucket).
  fetch(`${env("SUPABASE_URL")}/functions/v1/generate-kit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Generate-Secret": env("GENERATE_SECRET") },
    body: JSON.stringify({ intake_id: intake.id }),
  }).catch(() => {});

  return J({ intake_id: intake.id, status: "generating" });
});
