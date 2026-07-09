// Supabase Edge Function: generate-kit  (v2 — renders real .docx / .xlsx and zips the kit)
// SoloLaunch generation engine, shared by all verticals. Buyers receive finished
// Microsoft Word (.docx) and Excel (.xlsx) files, plus a .zip of the whole kit.
//
// Deploy:  supabase functions deploy generate-kit
// Secrets: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GENERATE_SECRET
// Prereqs: private Storage bucket "kits".
// Invoke:  POST { "intake_id": "uuid" }  with header X-Generate-Secret: <GENERATE_SECRET>
//
// Output mapping: artifact format 'xlsx' -> Excel (model outputs CSV); everything else
// (docx / md) -> Word (model outputs Markdown).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.69.0";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType,
} from "npm:docx@9.0.2";
import * as XLSX from "npm:xlsx@0.18.5";
import JSZip from "npm:jszip@3.10.1";

const env = (k: string) => Deno.env.get(k) ?? "";
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}
function fill(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => {
    const v = vars[k]; return (v === undefined || v === null || v === "") ? `[ACTION: provide ${k}]` : String(v);
  });
}

// --- inline bold (**x**) -> TextRuns ---
function runs(text: string): TextRun[] {
  const out: TextRun[] = [];
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**")) out.push(new TextRun({ text: part.slice(2, -2), bold: true }));
    else out.push(new TextRun(part));
  }
  return out.length ? out : [new TextRun(text)];
}
function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur); return out;
}

// --- Markdown -> .docx (subset our prompts emit: #/##/### headings, paragraphs, - / 1. lists, **bold**, | tables |) ---
async function mdToDocx(title: string, md: string): Promise<Uint8Array> {
  const children: (Paragraph | Table)[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] })];
  const lines = md.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // table block
    if (line.trim().startsWith("|") && lines[i + 1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i])) {
          rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        }
        i++;
      }
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: rows.map((r, ri) => new TableRow({
          children: r.map((c) => new TableCell({ children: [new Paragraph({ children: runs(c) })] })),
          tableHeader: ri === 0,
        })),
      }));
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lvl = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][h[1].length];
      children.push(new Paragraph({ heading: lvl, children: runs(h[2]) }));
    } else if (/^\s*[-*]\s+/.test(line)) {
      children.push(new Paragraph({ bullet: { level: 0 }, children: runs(line.replace(/^\s*[-*]\s+/, "")) }));
    } else if (/^\s*\d+\.\s+/.test(line)) {
      children.push(new Paragraph({ numbering: { reference: "num", level: 0 }, children: runs(line.replace(/^\s*\d+\.\s+/, "")) }));
    } else {
      children.push(new Paragraph({ children: runs(line) }));
    }
    i++;
  }
  const doc = new Document({
    numbering: { config: [{ reference: "num", levels: [{ level: 0, format: "decimal", text: "%1.", alignment: "start" }] }] },
    sections: [{ children }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

// --- CSV -> .xlsx (handles two blocks separated by a blank line -> two sheets) ---
function csvToXlsx(csv: string): Uint8Array {
  const blocks = csv.replace(/\r/g, "").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const wb = XLSX.utils.book_new();
  const names = blocks.length > 1 ? ["Assumptions", "Model", "Sheet3", "Sheet4"] : ["Sheet1"];
  blocks.forEach((b, idx) => {
    const aoa = b.split("\n").map(splitCsvLine);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), names[idx] || `Sheet${idx + 1}`);
  });
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

Deno.serve(async (req) => {
  if (!env("GENERATE_SECRET") || !safeEqual(req.headers.get("X-Generate-Secret") ?? "", env("GENERATE_SECRET")))
    return new Response("unauthorized", { status: 401 });
  const { intake_id } = await req.json().catch(() => ({}));
  if (!intake_id) return Response.json({ error: "intake_id required" }, { status: 400 });
  if (!env("ANTHROPIC_API_KEY")) return Response.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  const anthropic = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });

  const { data: intake, error: iErr } = await sb.from("intakes").select("*").eq("id", intake_id).single();
  if (iErr) return Response.json({ error: `intake: ${iErr.message}` }, { status: 404 });
  const { data: vertical } = await sb.from("verticals").select("*").eq("id", intake.vertical_id).single();
  if (!vertical) return Response.json({ error: "vertical not found" }, { status: 404 });

  const vars: Record<string, unknown> = {
    ...(intake.extra ?? {}),
    business_name: intake.business_name, idea: intake.idea, audience: intake.audience,
    target_customer: intake.audience, primary_goal: intake.primary_goal,
    category: intake.category, tone: intake.tone,
  };

  const { data: job } = await sb.from("generation_jobs")
    .insert({ intake_id, status: "running", attempts: 1, started_at: new Date().toISOString() }).select("id").single();
  const { data: kit } = await sb.from("kits")
    .insert({ order_id: intake.order_id, intake_id, vertical_id: intake.vertical_id, status: "generating" }).select("id").single();

  const { data: kinds } = await sb.from("artifact_kinds")
    .select("id, key, name, format, sort").eq("vertical_id", intake.vertical_id).order("sort");

  let tokIn = 0, tokOut = 0, actionFlags = 0;
  const produced: string[] = [];
  const zip = new JSZip();

  for (const ak of kinds ?? []) {
    const { data: tpl } = await sb.from("prompt_templates")
      .select("*").eq("artifact_kind_id", ak.id).eq("status", "active")
      .order("version", { ascending: false }).limit(1).maybeSingle();
    if (!tpl) continue;

    const msg = await anthropic.messages.create({
      model: tpl.model || "claude-sonnet-5",
      max_tokens: tpl.token_budget || 2000,
      system: tpl.system_prompt || vertical.system_prompt || "",
      messages: [{ role: "user", content: fill(tpl.user_template, vars) }],
    });
    const content = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    tokIn += msg.usage?.input_tokens ?? 0; tokOut += msg.usage?.output_tokens ?? 0;
    actionFlags += (content.match(/\[ACTION:/g) || []).length;

    await sb.from("agent_runs").insert({
      vertical_id: intake.vertical_id, job_id: job?.id, agent: "generate-kit", model: tpl.model, status: "done",
      tokens_in: msg.usage?.input_tokens ?? 0, tokens_out: msg.usage?.output_tokens ?? 0,
      output: { text: content }, finished_at: new Date().toISOString(),
    });

    // Render to a finished Office file.
    let bytes: Uint8Array, ext: string, ctype: string;
    if (ak.format === "xlsx") {
      bytes = csvToXlsx(content); ext = "xlsx";
      ctype = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    } else {
      bytes = await mdToDocx(ak.name, content); ext = "docx";
      ctype = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    const filename = `${String(ak.sort).padStart(2, "0")}_${ak.key}.${ext}`;
    const path = `${kit!.id}/${filename}`;
    await sb.storage.from("kits").upload(path, bytes, { contentType: ctype, upsert: true });
    zip.file(filename, bytes);
    await sb.from("kit_artifacts").insert({
      kit_id: kit!.id, kind: ak.key, artifact_kind_id: ak.id, filename, storage_path: path, bytes: bytes.length,
    });
    produced.push(ak.key);
  }

  // Bundle the whole kit as a .zip.
  const zipBytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
  const zipPath = `${kit!.id}/kit.zip`;
  await sb.storage.from("kits").upload(zipPath, zipBytes, { contentType: "application/zip", upsert: true });

  const confidence = Math.max(0.4, 1 - actionFlags * 0.05);
  const reviewRequired = vertical.risk_tier === "gated" ||
    (vertical.risk_tier === "gated_on_low_confidence" && confidence < 0.7);

  await sb.from("kits").update({
    status: reviewRequired ? "needs_review" : "ready",
    review_status: reviewRequired ? "pending" : "auto_approved",
    zip_path: zipPath, confidence, manifest: { artifacts: produced, formats: "docx+xlsx" },
    delivered_at: reviewRequired ? null : new Date().toISOString(),
  }).eq("id", kit!.id);

  await sb.from("generation_jobs").update({
    status: "done", tokens_in: tokIn, tokens_out: tokOut, confidence,
    review_required: reviewRequired, finished_at: new Date().toISOString(),
  }).eq("id", job!.id);

  await sb.from("cost_events").insert({
    kind: "generation", order_id: intake.order_id, job_id: job!.id,
    amount_cents: Math.round((tokIn * 0.003 + tokOut * 0.015) / 10),
    meta: { tokens_in: tokIn, tokens_out: tokOut, artifacts: produced.length },
  });

  return Response.json({
    kit_id: kit!.id, artifacts: produced, zip_path: zipPath, confidence,
    review_required: reviewRequired, tokens: { in: tokIn, out: tokOut },
  });
});
