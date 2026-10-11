#!/usr/bin/env python3
"""Deploy a Supabase Edge Function via the Management API (generic slug).

Usage: python3 deploy.py <slug> [--no-verify-jwt]
Expects supabase/functions/<slug>/index.ts relative to this script's parent.
"""
import sys, os, json, urllib.request

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import dynamic_credential_entry, ensure_allowed_url, read_json_response

API_HOST = "api.supabase.com"
PROJECT_REF = "kgtpblgzbfdbxwejnlrr"

def main():
    slug = sys.argv[1]
    verify_jwt = "--no-verify-jwt" not in sys.argv
    base = os.path.dirname(os.path.abspath(__file__))
    fn_dir = os.path.join(base, "functions", slug)
    entry = os.path.join(fn_dir, "index.ts")
    if not os.path.isfile(entry):
        sys.exit(f"missing {entry}")

    with open(entry, "rb") as f:
        content = f.read()

    cred = dynamic_credential_entry("custom.supabase", "access_token")
    surrogate = cred["surrogate"]
    url = f"https://{API_HOST}/v1/projects/{PROJECT_REF}/functions/deploy?slug={slug}"
    ensure_allowed_url(url, [API_HOST])

    boundary = "----ring-deploy-boundary-1"
    parts = []
    def field(name, val, ctype="application/json"):
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(f'Content-Disposition: form-data; name="{name}"\r\n'.encode())
        parts.append(f"Content-Type: {ctype}\r\n\r\n".encode())
        parts.append(val if isinstance(val, bytes) else val.encode())
        parts.append(b"\r\n")
    field("metadata", json.dumps({
        "entrypoint_path": f"{slug}/index.ts",
        "name": slug,
        "verify_jwt": verify_jwt,
    }))
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(f'Content-Disposition: form-data; name="file"; filename="{slug}/index.ts"\r\n'.encode())
    parts.append(b"Content-Type: application/typescript\r\n\r\n")
    parts.append(content)
    parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)

    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Authorization", f"Bearer {surrogate}")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            print(f"HTTP {resp.status}")
            print(json.dumps(read_json_response(resp), indent=2)[:1500])
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode(errors='replace')[:1500]}")
        raise

if __name__ == "__main__":
    main()
