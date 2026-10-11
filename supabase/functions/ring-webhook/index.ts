// supabase/functions/ring-webhook/index.ts
//
// Ring Partner API webhook receiver (Deno / Supabase Edge Function).
//
// Flow:
//   1. Read the RAW body bytes (required for HMAC verification — must happen
//      before any JSON parsing).
//   2. Verify the `X-Signature` header: HMAC-SHA256(rawBody, HMAC signing key),
//      hex encoded. (Ring docs: "Webhook Notifications".)
//   3. Parse the event (JSON:API). Persist the raw payload no matter what so
//      unknown shapes are never lost.
//   4. For motion_detected / button_press: fetch an image snapshot from the
//      Ring API and store it in the `ring-snapshots` storage bucket.
//   5. Upsert into `ring_events` (idempotent on Ring's event id — Ring
//      retries deliveries).
//   6. Fire-and-forget trigger of `analyze-snapshot` for AI classification.
//
// Env vars (supabase secrets):
//   RING_HMAC_KEY      - HMAC signing key issued at app creation (hex or raw)
//   RING_ACCESS_TOKEN  - Bearer token (Playground short-lived token for dev;
//                        OAuth access token in production)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY - standard
//
// Official refs:
//   Webhooks:  https://developer.amazon.com/docs/ring/api-documentation.html
//              (Endpoint Reference -> Webhook Events; Notifications guide)
//   Snapshots: POST https://api.amazonvision.com/v1/devices/{id}/media/image/download

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RING_API_BASE = "https://api.amazonvision.com";

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

/** Constant-time string comparison (no node:crypto dependency). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** The HMAC signing key may be issued as hex or as a raw string — handle both. */
function keyBytes(key: string): Uint8Array {
  if (/^[0-9a-fA-F]+$/.test(key) && key.length % 2 === 0 && key.length >= 32) {
    const b = new Uint8Array(key.length / 2);
    for (let i = 0; i < b.length; i++) {
      b[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
    }
    return b;
  }
  return new TextEncoder().encode(key);
}

/** Verify X-Signature = hex(HMAC-SHA256(rawBody, hmacKey)). */
async function verifySignature(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  hmacKey: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes(hmacKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, rawBody);
  const hex = [...new Uint8Array(sig)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const want = signatureHeader.replace(/^sha256=/i, "").trim().toLowerCase();
  return timingSafeEqual(hex, want);
}

interface ParsedEvent {
  ringEventId: string;
  type: string; // motion_detected | button_press | device_online | ...
  deviceId: string;
  subType?: string; // e.g. "human" on motion_detected
  occurredAt: string; // ISO
}

/**
 * Best-effort parse of the JSON:API webhook payload.
 * Unknown shapes still persist (raw column) — never drop data.
 */
function parseEvent(body: unknown): ParsedEvent | null {
  try {
    const root = body as Record<string, any>;
    const d = root?.data ?? root;
    const attrs: Record<string, any> = d?.attributes ?? {};
    const type: string =
      d?.type ?? attrs?.event_type ?? attrs?.type ?? "";
    if (!type) return null;
    return {
      ringEventId: String(
        d?.id ?? attrs?.event_id ?? `${type}-${Date.now()}`,
      ),
      type,
      deviceId: String(
        attrs?.device_id ?? attrs?.deviceId ?? d?.device_id ?? "unknown",
      ),
      subType: attrs?.sub_type ?? attrs?.subType,
      occurredAt:
        attrs?.occurred_at ?? attrs?.timestamp ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** Fetch a JPEG/PNG snapshot for a device. Returns null on any failure. */
async function fetchSnapshot(
  deviceId: string,
  accessToken: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  try {
    const res = await fetch(
      `${RING_API_BASE}/v1/devices/${deviceId}/media/image/download`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!res.ok) {
      console.error("snapshot fetch failed", res.status, await res.text());
      return null;
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "image/jpeg",
    };
  } catch (e) {
    console.error("snapshot fetch error", e);
    return null;
  }
}

const SNAPSHOT_EVENTS = new Set(["motion_detected", "button_press"]);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // 1. Raw body FIRST — parsing as JSON first would break signature checks
  //    on any body whose serialization differs.
  const rawBody = new Uint8Array(await req.arrayBuffer());

  // 2. Verify signature before trusting anything.
  const ok = await verifySignature(
    rawBody,
    req.headers.get("x-signature"),
    env("RING_HMAC_KEY"),
  );
  if (!ok) {
    console.warn("webhook signature verification failed");
    return new Response("invalid signature", { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const evt = parseEvent(body);
  const supabase = createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
  );

  // 3–6. Persist (idempotent) + snapshot + AI trigger.
  const done = (async () => {
    let snapshotPath: string | null = null;

    if (evt && SNAPSHOT_EVENTS.has(evt.type)) {
      const snap = await fetchSnapshot(evt.deviceId, env("RING_ACCESS_TOKEN"));
      if (snap && snap.bytes.length > 0) {
        const ext = snap.contentType.includes("png") ? "png" : "jpg";
        snapshotPath = `${evt.deviceId}/${evt.ringEventId}.${ext}`;
        const { error } = await supabase.storage
          .from("ring-snapshots")
          .upload(snapshotPath, snap.bytes, {
            contentType: snap.contentType,
            upsert: true,
          });
        if (error) {
          console.error("snapshot upload failed", error);
          snapshotPath = null;
        }
      }
    }

    const { error } = await supabase.from("ring_events").upsert(
      {
        ring_event_id: evt?.ringEventId ?? `unknown-${Date.now()}`,
        event_type: evt?.type ?? "unparsed",
        device_id: evt?.deviceId ?? "unknown",
        sub_type: evt?.subType ?? null,
        occurred_at: evt?.occurredAt ?? new Date().toISOString(),
        snapshot_path: snapshotPath,
        raw: body,
      },
      { onConflict: "ring_event_id" },
    );
    if (error) console.error("ring_events upsert failed", error);

    // 6. Kick off AI classification (fire-and-forget).
    if (evt && SNAPSHOT_EVENTS.has(evt.type) && snapshotPath) {
      try {
        await supabase.functions.invoke("analyze-snapshot", {
          body: {
            ring_event_id: evt.ringEventId,
            snapshot_path: snapshotPath,
          },
        });
      } catch (e) {
        console.error("analyze-snapshot invoke failed", e);
      }
    }
  })();

  // Return 200 fast — Ring retries deliveries, so never keep it waiting.
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(done);
  else await done;

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
