-- APPLIED 2026-06-27 to SoloLaunch (xiqdmfuifvmuewhycgsk).
-- Turns on the solopreneur (B2C) vertical: sets its system prompt + buyer intake schema
-- and adds the 5 prompt templates for its already-defined artifacts. Idempotent.
--
-- Note on placeholders: the generation runner is expected to flatten the `intakes` row
-- (business_name, idea, audience, primary_goal, category, tone) plus the `extra` jsonb
-- into the {placeholder} variables used below (e.g. {product}, {price_point}, {stage},
-- {monthly_goal} come from intake.extra), matching the existing grantlaunch/federal pattern.

update public.verticals set
  system_prompt = $sp$You are a pragmatic startup operator helping a solo founder or small creator launch a business. Produce concrete, ready-to-use, tailored materials — specific to their idea, product, customer, and price point — not generic filler. Prefer realistic numbers and specific tactics. Flag anything the founder must decide or supply as [ACTION: ...]. This is a drafting accelerator and general guidance, not legal, tax, or financial advice, and not a guarantee of results. Output clean Markdown unless asked to output CSV.$sp$,
  intake_schema = $js${"fields":[
    {"key":"business_name","label":"Business name","type":"text","required":true},
    {"key":"idea","label":"One-line description of your business","type":"text","required":true},
    {"key":"product","label":"What you sell (product/service)","type":"text","required":true},
    {"key":"target_customer","label":"Who your ideal customer is","type":"text","required":true},
    {"key":"price_point","label":"Typical price / pricing model","type":"text","required":false},
    {"key":"stage","label":"Stage (idea / building / launched)","type":"select","options":["idea","building","launched"],"required":false},
    {"key":"monthly_goal","label":"Revenue goal (first 6-12 months)","type":"text","required":false}
  ]}$js$::jsonb
where slug = 'solopreneur';

-- (5 prompt_templates inserted for business_plan, financial_model, project_plan,
--  brand_gtm, site_starter — full user_template/rubric text as reviewed in
--  supabase/sololaunch/DRAFT_solopreneur_templates.md; model claude-sonnet-5.)
-- See the DRAFT doc for the exact template bodies applied.
