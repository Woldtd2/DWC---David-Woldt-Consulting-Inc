// Supabase Edge Function: kit-download
// Buyer-facing delivery. Given a paid order (ls_order_id + email), returns time-limited
// signed download URLs for the generated kit's files (individual .docx/.xlsx + the .zip).
//
// Deploy:  supabase functions deploy kit-download  (verify_jwt=false — buyer-facing)
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Invoke:  POST { "ls_order_id": "...", "email": "..." }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const EXPIRY = 60 * 60 * 24; // 24h

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const J = (b: unknown, s = 200) => Response.json(b, { status: s, headers: cors });

  const { ls_order_id, email } = await req.json().catch(() => ({}));
  if (!ls_order_id || !email) return J({ error: "ls_order_id and email required" }, 400);

  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  const { data: order } = await sb.from("orders")
    .select("id, email, status").eq("ls_order_id", String(ls_order_id)).maybeSingle();
  if (!order || order.status !== "paid" || (order.email ?? "").toLowerCase() !== String(email).toLowerCase())
    return J({ error: "no matching paid order" }, 401);

  const { data: kit } = await sb.from("kits")
    .select("id, status, review_status, zip_path, delivered_at")
    .eq("order_id", order.id).order("created_at", { ascending: false }).maybeSingle();
  if (!kit) return J({ status: "not_started", message: "Kit not generated yet." });
  if (kit.status === "generating") return J({ status: "generating", message: "Your kit is being generated." });
  if (kit.status === "needs_review")
    return J({ status: "in_review", message: "Your kit is being quality-reviewed and will be released shortly." });

  const { data: arts } = await sb.from("kit_artifacts")
    .select("filename, storage_path, bytes").eq("kit_id", kit.id).order("filename");

  const files: any[] = [];
  for (const a of arts ?? []) {
    const { data: signed } = await sb.storage.from("kits").createSignedUrl(a.storage_path, EXPIRY);
    if (signed?.signedUrl) files.push({ filename: a.filename, bytes: a.bytes, url: signed.signedUrl });
  }
  let zipUrl: string | null = null;
  if (kit.zip_path) {
    const { data: z } = await sb.storage.from("kits").createSignedUrl(kit.zip_path, EXPIRY);
    zipUrl = z?.signedUrl ?? null;
  }

  return J({ status: "ready", kit_id: kit.id, expires_in: EXPIRY, zip_url: zipUrl, files });
});
