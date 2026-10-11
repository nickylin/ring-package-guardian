// supabase/functions/snapshot-url/index.ts
//
// Dashboard helper: mint a short-lived signed URL for a private-bucket
// snapshot so the static dashboard can display images without exposing
// the service role key.
//
// POST { "path": "<storage path in ring-snapshots>" }
//   -> { "url": "<signed url, 10 min>" }
//
// Env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (standard)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

Deno.serve(async (req) => {
  // CORS for the static dashboard
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let path: string;
  try {
    path = (await req.json()).path;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  // Basic path hygiene: no traversal, must live under ring-snapshots
  if (!path || typeof path !== "string" || path.includes("..")) {
    return new Response("bad path", { status: 400 });
  }

  const supabase = createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
  );

  const { data, error } = await supabase.storage
    .from("ring-snapshots")
    .createSignedUrl(path, 600); // 10 minutes
  if (error || !data?.signedUrl) {
    console.error("createSignedUrl failed", error);
    return new Response("not found", { status: 404 });
  }

  return new Response(JSON.stringify({ url: data.signedUrl }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
