# Security Policy

`claude-proxy` fronts a personal **Claude Pro/Max subscription**. Treat it as a
single-user, owner-operated service — not a multi-tenant public API.

## Reporting a vulnerability

Please report privately via **GitHub → Security → "Report a vulnerability"**
(private advisory) rather than a public issue. Include repro steps and impact.
You'll get an acknowledgement; fixes ship as normal PRs once triaged.

## Security model

| Secret | Who holds it | Grants |
|---|---|---|
| **`API_KEY`** (env, legacy) | your clients | inference only — call the proxy |
| **Per-app keys** `cxk_<keyId>_<secret>` | one per project | inference only; individually revocable by key-id |
| **`ADMIN_SECRET`** | you (owner) | the admin plane: mint/revoke keys, OAuth setup, logout |
| **Upstream Claude token** | the server (Redis) | the actual Anthropic access — never exposed to clients |

Properties: OAuth 2.0 + PKCE with a server-issued single-use `state`; **fail-closed**
everywhere (no auth source → refuse; `ADMIN_SECRET` unset → admin plane denied;
Redis error on a key lookup → deny); per-app secrets stored only as `sha256`
hashes, compared in constant time; the admin plane is a **distinct** secret from
client keys.

## Revocation runbook

**Revoke one project** (leaked/rotated per-app key):
```
curl -X POST "$PROXY_URL/api/keys/<keyId>/revoke" -H "Authorization: Bearer $ADMIN_SECRET"
```
Effective within seconds, from any IP.

**Revoke everything downstream** (kill all per-app keys at once):
```
curl -X POST "$PROXY_URL/api/keys/revoke-all" -H "Authorization: Bearer $ADMIN_SECRET"
```
If you also use the legacy env `API_KEY`, rotate it in the Vercel env and redeploy
(env keys are not registry-revocable — they are break-glass only).

**Revoke the upstream Claude token** (the crown jewel — the only true kill of a
*copied* upstream token): **claude.ai → Settings → Connected apps / Authorizations →
remove the authorization**, then re-connect from the proxy's landing page.
⚠️ Per OAuth, revoking the grant stops future *refreshes* but a copied *access*
token may keep working until it expires — watch usage until then.

## Suspected full compromise — order matters

Kill the credentials that can undo later steps **first**:

1. **Rotate the "watchers"** — Upstash `UPSTASH_REDIS_REST_TOKEN`, then Vercel
   deploy/CI tokens (a Redis/env-dump holder can otherwise watch you rotate).
2. **Rotate `ADMIN_SECRET`** (Vercel env → redeploy).
3. **Contain upstream** — revoke + re-connect the Claude authorization (above).
4. **Contain downstream** — `POST /api/keys/revoke-all`; delete the env `API_KEY`;
   **redeploy** so no warm instance keeps a stale key.
5. **Verify** on a fresh request: revoked keys 401; admin routes reject non-admin;
   the revoke check fails **closed** (deny on a simulated Redis error).
