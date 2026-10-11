# 📦 Ring Package Guardian

AI-powered package protection for your front door. Built for the **Amazon Developer Hackathon 2026 — Ring track**.

Ring doorbell motion/ding webhooks → snapshot capture → AI vision classification (person / package / pet / vehicle / none) → smart alerts (package arrived, package removed, night activity) → realtime dashboard.

## Live demo

- **Dashboard**: https://ring-package-guardian.pages.dev (realtime event timeline, AI labels, alert banner)

## Architecture

```
Ring device / simulator
  │ motion_detected / button_press webhook (HMAC-SHA256 verified)
  ▼
Supabase Edge Function: ring-webhook
  │ fetch snapshot via Ring API, store event (idempotent)
  ▼
Supabase Edge Function: analyze-snapshot
  │ Gemini vision (free tier) classifies the snapshot
  │ alert rules → ring_alerts (package_arrived / package_removed / night_activity)
  ▼
Dashboard (static, Cloudflare Pages)
  │ realtime timeline + snapshots (signed URLs) + alert banner
```

## Project layout

- `supabase/functions/ring-webhook/` — webhook receiver: raw-body HMAC verification, JSON:API parsing, snapshot fetch from Ring API (`POST /v1/devices/{id}/media/image/download`), idempotent upsert into `ring_events`, fire-and-forget AI trigger
- `supabase/functions/analyze-snapshot/` — downloads snapshot from private bucket, classifies with an OpenAI-compatible vision endpoint (env: `VISION_API_BASE` / `VISION_API_KEY` / `VISION_MODEL`; mock mode when unset), writes `ai_label`/`ai_confidence` back, evaluates alert rules into `ring_alerts`
- `supabase/functions/snapshot-url/` — mints short-lived signed URLs for the dashboard
- `supabase/migrations/` — `ring_events` + `ring_alerts` tables, `ring-snapshots` private bucket, dashboard read-only RLS
- `supabase/deploy.py` — deploy helper (Management API)
- `dashboard/` — static realtime dashboard (`index.html`/`app.js`/`styles.css`)
- `simulator/send-event.mjs` — hardware-free E2E tester; signs payloads with the same HMAC-SHA256 scheme
- `docs/friction-log.md` — build friction log

## Run it

```bash
# 1. Supabase secrets (dashboard > project settings, or Management API)
RING_HMAC_KEY=      # HMAC signing key from Ring app credentials (one-time display!)
RING_ACCESS_TOKEN=  # Playground token (dev) / OAuth token (prod)
VISION_API_BASE=    # OpenAI-compatible chat completions endpoint
VISION_API_KEY=     # vision provider key
VISION_MODEL=       # e.g. gemini-2.5-flash-lite

# 2. Apply migrations (supabase/migrations/*.sql), deploy functions:
python3 supabase/deploy.py ring-webhook --no-verify-jwt
python3 supabase/deploy.py analyze-snapshot --no-verify-jwt
python3 supabase/deploy.py snapshot-url --no-verify-jwt

# 3. Simulate an event (no hardware needed)
RING_HMAC_KEY=<key> node simulator/send-event.mjs \
  --url=https://<ref>.supabase.co/functions/v1/ring-webhook \
  --type=motion_detected --device=sim-doorbell-1 --sub-type=human
```

## Submission checklist

- [x] GitHub repo with real Ring API usage (webhook receiver + snapshot fetch + Playground-verified `GET /v1/devices`)
- [ ] 3-minute demo video (YouTube, public, English)
- [ ] Project write-up on Devpost
- [ ] Product feedback per tool/API used
- [x] Friction log (`docs/friction-log.md`)
- [ ] Track: Ring

Deadline: **2026-10-24 03:00 CST**. Contest: https://amazonappdev2026.devpost.com/

## License

MIT — see [LICENSE](LICENSE).
