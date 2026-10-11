// supabase/functions/analyze-snapshot/index.ts
//
// AI snapshot classifier for the Ring Package Guardian hackathon
// (Deno / Supabase Edge Function).
//
// Flow:
//   1. POST { ring_event_id, snapshot_path } — invoked (fire-and-forget)
//      by `ring-webhook` after a snapshot is stored in the `ring-snapshots`
//      bucket. No verify_jwt: trust comes from the service_role caller.
//   2. Download the snapshot bytes from the private `ring-snapshots` bucket.
//   3. Classify the image with an OpenAI-compatible vision endpoint.
//      If any of VISION_API_BASE / VISION_API_KEY / VISION_MODEL is missing,
//      fall back to mock mode (deterministic pseudo-random label from a hash
//      of snapshot_path) so local E2E still works.
//   4. Write ai_label / ai_confidence back to `ring_events`.
//   5. Evaluate alert rules and insert rows into `ring_alerts`.
//
// Env vars (supabase secrets):
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY - standard
//   VISION_API_BASE - OpenAI-compatible chat completions endpoint, e.g.
//                     https://xxx/v1/chat/completions
//   VISION_API_KEY  - bearer key for the vision endpoint
//   VISION_MODEL    - model name, e.g. amazon.nova-lite-v1:0 on Bedrock
//
// Tables:
//   ring_events (migration 20261005000000_ring_events.sql)
//   ring_alerts (created here with `create table if not exists` as a safety
//                net; prefer adding it to a real migration too)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SNAPSHOT_BUCKET = "ring-snapshots";
const VALID_LABELS = new Set(["person", "package", "pet", "vehicle", "none"]);

function env(name: string): string | undefined {
  return Deno.env.get(name);
}

function must(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

interface Classification {
  label: string;
  confidence: number;
  note: string;
  mock: boolean;
}

/** Chunked binary -> base64 (btoa chokes on huge single strings). */
function toBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** FNV-1a 32-bit hash — deterministic, good enough for mock classification. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mock mode: pseudo-random label from the snapshot path hash. */
function mockClassify(snapshotPath: string): Classification {
  const labels = ["person", "package", "pet", "vehicle", "none"];
  const h = fnv1a(snapshotPath);
  const label = labels[h % labels.length];
  const confidence = 0.6 + ((h >>> 8) % 36) / 100; // 0.60 - 0.95
  return {
    label,
    confidence: Math.round(confidence * 100) / 100,
    note: `[mock] no VISION_* env configured; pseudo label from path hash for local E2E`,
    mock: true,
  };
}

const SYSTEM_PROMPT =
  `You are an image classifier for a doorbell camera. Look at the image and ` +
  `decide what is the most prominent subject near the door. ` +
  `Return ONLY a JSON object, no markdown, no extra text, with exactly these fields: ` +
  `{"label": "person|package|pet|vehicle|none", "confidence": <0.0-1.0>, ` +
  `"note": "<one short English sentence describing what you see>"}. ` +
  `Use "package" only if a parcel/box/envelope is clearly visible. ` +
  `Use "none" if the frame is empty or nothing relevant is visible.`;

/** Strip possible ```json fences around the model output. */
function extractJson(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
}

async function classifyLive(
  imageBytes: Uint8Array,
  mime: string,
): Promise<Classification> {
  const base = must("VISION_API_BASE");
  const key = must("VISION_API_KEY");
  const model = must("VISION_MODEL");

  const dataUrl = `data:${mime};base64,${toBase64(imageBytes)}`;
  const res = await fetch(base, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
      max_tokens: 200,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`vision api ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const content: string =
    data?.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("vision api returned empty content");

  let parsed: { label?: unknown; confidence?: unknown; note?: unknown };
  try {
    parsed = JSON.parse(extractJson(content));
  } catch {
    throw new Error(`vision api returned non-JSON: ${content.slice(0, 120)}`);
  }

  const label = String(parsed.label ?? "none").toLowerCase();
  const rawConf = Number(parsed.confidence);
  return {
    label: VALID_LABELS.has(label) ? label : "none",
    confidence: Number.isFinite(rawConf)
      ? Math.min(1, Math.max(0, rawConf))
      : 0.5,
    note: String(parsed.note ?? "").slice(0, 280),
    mock: false,
  };
}

async function classify(
  imageBytes: Uint8Array,
  mime: string,
  snapshotPath: string,
): Promise<Classification> {
  if (!env("VISION_API_BASE") || !env("VISION_API_KEY") || !env("VISION_MODEL")) {
    console.warn("VISION_* env missing — using mock classification");
    return mockClassify(snapshotPath);
  }
  try {
    return await classifyLive(imageBytes, mime);
  } catch (e) {
    // Vision failures must not break the pipeline: degrade to mock so the
    // event still gets a label and alerts still evaluate.
    console.error("live classification failed, falling back to mock", e);
    const m = mockClassify(snapshotPath);
    m.note = `[fallback] vision error: ${String(e).slice(0, 120)}; ${m.note}`;
    return m;
  }
}

function mimeFromPath(path: string): string {
  return path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
}

const CREATE_ALERTS_SQL = `
create table if not exists public.ring_alerts (
  id uuid primary key default gen_random_uuid(),
  device_id text,
  alert_type text,
  ring_event_id text,
  message text,
  created_at timestamptz not null default now()
);
create index if not exists ring_alerts_device_time
  on public.ring_alerts (device_id, created_at desc);
`;

/**
 * Safety net: make sure ring_alerts exists before we insert.
 * Uses an optional `exec_sql(text)` RPC helper if the project has one
 * (many Supabase projects add it); silently skips if unavailable — the
 * insert below will surface a real error in that case.
 */
async function ensureAlertsTable(supabase: ReturnType<typeof createClient>) {
  const probe = await supabase
    .from("ring_alerts")
    .select("id", { head: true, count: "exact" });
  if (!probe.error) return; // table exists
  console.warn("ring_alerts probe failed, attempting create table:", probe.error.message);
  for (const rpcName of ["exec_sql", "pg_exec", "execute_sql"]) {
    try {
      const { error } = await supabase.rpc(rpcName, { sql: CREATE_ALERTS_SQL });
      if (!error) {
        console.log(`ring_alerts created via rpc ${rpcName}`);
        return;
      }
    } catch {
      // helper not present — try next name
    }
  }
  console.warn("no exec_sql helper available; relying on migration for ring_alerts");
}

/** Hour of day in Asia/Shanghai for an ISO timestamp. */
function beijingHour(iso: string): number {
  return (new Date(iso).getUTCHours() + 8) % 24;
}

interface EventRow {
  ring_event_id: string;
  event_type: string;
  device_id: string;
  occurred_at: string;
}

interface Alert {
  alert_type: string;
  message: string;
}

function evaluateAlerts(
  current: EventRow,
  label: string,
  prevLabel: string | null,
): Alert[] {
  const alerts: Alert[] = [];
  const h = beijingHour(current.occurred_at);
  const isNight = h >= 23 || h < 6;

  // Package arrived: no package in the previous AI classification, package now.
  if (label === "package" && prevLabel !== "package") {
    alerts.push({
      alert_type: "package_arrived",
      message: `Package detected at device ${current.device_id} (event ${current.ring_event_id}).`,
    });
  }

  // Package removed: package before, now a person and no package.
  if (prevLabel === "package" && label === "person") {
    alerts.push({
      alert_type: "package_removed",
      message: `Package no longer visible — person detected at device ${current.device_id} (event ${current.ring_event_id}). Possible pickup or theft.`,
    });
  }

  // Night activity: motion between 23:00 and 06:00 Beijing time with something in frame.
  if (current.event_type === "motion_detected" && isNight && label !== "none") {
    alerts.push({
      alert_type: "night_activity",
      message: `Night-time motion (${label}) detected at device ${current.device_id} at ${current.occurred_at} (Beijing ${String(h).padStart(2, "0")}:xx).`,
    });
  }

  return alerts;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let body: { ring_event_id?: unknown; snapshot_path?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "bad json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ringEventId = String(body.ring_event_id ?? "");
  const snapshotPath = String(body.snapshot_path ?? "");
  if (!ringEventId || !snapshotPath) {
    return new Response(
      JSON.stringify({ ok: false, error: "ring_event_id and snapshot_path are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(
    must("SUPABASE_URL"),
    must("SUPABASE_SERVICE_ROLE_KEY"),
  );

  // 1. Download the snapshot bytes from the private bucket.
  const { data: file, error: dlErr } = await supabase.storage
    .from(SNAPSHOT_BUCKET)
    .download(snapshotPath);
  if (dlErr || !file) {
    console.error("snapshot download failed", dlErr);
    return new Response(
      JSON.stringify({ ok: false, error: `snapshot download failed: ${dlErr?.message ?? "empty"}` }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  const imageBytes = new Uint8Array(await file.arrayBuffer());
  if (imageBytes.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: "snapshot is empty" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. Classify.
  const result = await classify(imageBytes, mimeFromPath(snapshotPath), snapshotPath);
  console.log("classification", ringEventId, result.label, result.confidence, result.mock ? "(mock)" : "");

  // 3. Write the result back to ring_events.
  const { data: evt, error: evtErr } = await supabase
    .from("ring_events")
    .select("ring_event_id, event_type, device_id, occurred_at")
    .eq("ring_event_id", ringEventId)
    .maybeSingle();
  if (evtErr || !evt) {
    console.error("ring_events lookup failed", evtErr);
    return new Response(
      JSON.stringify({ ok: false, error: "ring event not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }
  const event = evt as EventRow;

  const { error: updErr } = await supabase
    .from("ring_events")
    .update({ ai_label: result.label, ai_confidence: result.confidence })
    .eq("ring_event_id", ringEventId);
  if (updErr) {
    console.error("ring_events update failed", updErr);
    return new Response(
      JSON.stringify({ ok: false, error: "failed to write classification" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // 4. Alert rules: compare against the most recent previous AI-classified
  //    event from the same device (last 24h).
  const since = new Date(new Date(event.occurred_at).getTime() - 24 * 3600 * 1000).toISOString();
  const { data: prevRows, error: prevErr } = await supabase
    .from("ring_events")
    .select("ai_label")
    .eq("device_id", event.device_id)
    .neq("ring_event_id", ringEventId)
    .not("ai_label", "is", null)
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(1);
  if (prevErr) console.error("previous event lookup failed", prevErr);
  const prevLabel: string | null =
    prevRows && prevRows.length > 0 ? String(prevRows[0].ai_label) : null;

  const alerts = evaluateAlerts(event, result.label, prevLabel);
  if (alerts.length > 0) {
    await ensureAlertsTable(supabase);
    const { error: alertErr } = await supabase.from("ring_alerts").insert(
      alerts.map((a) => ({
        device_id: event.device_id,
        alert_type: a.alert_type,
        ring_event_id: ringEventId,
        message: a.message,
      })),
    );
    if (alertErr) console.error("ring_alerts insert failed", alertErr);
    else console.log("alerts raised", alerts.map((a) => a.alert_type).join(","));
  }

  return new Response(
    JSON.stringify({ ok: true, label: result.label, confidence: result.confidence }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
