# claude-proxy

Use your **Claude Pro/Max subscription** as the model backend in Cursor IDE — no extra API bill.

[![CI](https://github.com/elzinko/claude-proxy/actions/workflows/pr-tests.yml/badge.svg)](https://github.com/elzinko/claude-proxy/actions/workflows/pr-tests.yml)
[![CodeQL](https://github.com/elzinko/claude-proxy/actions/workflows/codeql.yml/badge.svg)](https://github.com/elzinko/claude-proxy/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/elzinko/claude-proxy/badge)](https://scorecard.dev/viewer/?uri=github.com/elzinko/claude-proxy)
[![Tests](https://img.shields.io/badge/tests-150%20passing-brightgreen)](.github/workflows/pr-tests.yml)
[![Dependabot](https://img.shields.io/badge/Dependabot-enabled-025E8C?logo=dependabot&logoColor=white)](.github/dependabot.yml)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-%E2%98%95-FFDD00)](https://buymeacoffee.com/elzinko)

Cursor speaks the OpenAI wire format; Anthropic does not, and Cursor has no field for a Claude subscription. This proxy sits between them: it accepts Cursor's OpenAI-compatible requests, authenticates to your Claude account over OAuth, and forwards to Anthropic. Your subscription pays for the tokens — no separate Anthropic API key.

```
Cursor IDE → Proxy (Vercel) → Anthropic API (your Claude subscription)
```

> ⚠️ **Cursor blocks connections to private/local IPs.** The proxy **must** be deployed on a public server (Vercel recommended). Running it on `localhost` will not work with Cursor.

---

## Quick start

### 1. Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/elzinko/claude-proxy&env=API_KEY&envDescription=Secret%20key%20to%20protect%20your%20proxy&integration-ids=oac_V3R1GIpkoJorr6fqyiwdhl17)

- Set `API_KEY` to a secret string of your own (e.g. `openssl rand -hex 32`) — clients present it to reach the proxy.
- Set `ADMIN_SECRET` to a **different** secret — it gates the owner-only key-admin plane (see [Per-app keys](#per-app-keys)). Leave it unset and those routes stay fail-closed.
- Add **Upstash Redis** from the Vercel Marketplace (required — stores OAuth tokens and the key registry).

→ See the **[Deployment Guide](docs/DEPLOYMENT.md)** for step-by-step instructions and the full env-var table.

### 2. Authenticate with Claude

Open your Vercel URL in a browser and click **"Connect with Claude"**. Sign in with your Claude Pro/Max account.

### 3. Configure Cursor

→ See the **[Cursor Setup Guide](docs/SETUP.md)** for the base URL and the custom model names.

---

## Per-app keys

Beyond the single env `API_KEY`, the owner can mint a distinct key per project so any one can be revoked without rotating the rest. Minting lives behind `ADMIN_SECRET`, never a client key.

```bash
# Mint a key — the plaintext is returned ONCE and never stored in the clear.
curl -X POST "$PROXY_URL/api/keys" \
     -H "Authorization: Bearer $ADMIN_SECRET" \
     -d '{"label":"my-app"}'
# → { "key": "cxk_<keyId>_<secret>", "keyId": "<keyId>", "label": "my-app", ... }

# List keys (metadata only — never the secret).
curl "$PROXY_URL/api/keys" -H "Authorization: Bearer $ADMIN_SECRET"

# Revoke by key-id (idempotent). The secret is not needed to revoke.
curl -X POST "$PROXY_URL/api/keys/<keyId>/revoke" \
     -H "Authorization: Bearer $ADMIN_SECRET"
```

Clients send the minted key as `Authorization: Bearer cxk_<keyId>_<secret>`. The legacy env `API_KEY` keeps working alongside the registry, so nothing breaks if you never mint one.

---

## Security

- **OAuth 2.0 + PKCE** — you log in with your Claude account; no password is ever stored.
- **`API_KEY` + a distinct `ADMIN_SECRET`** — client keys and the owner admin plane are separate secrets. Minting/revoking keys is never reachable with a client key.
- **Fail-closed** — with no auth source configured (no `API_KEY` and no key registry) the proxy refuses every request rather than opening up; the admin plane denies when `ADMIN_SECRET` is unset.
- **Per-app key-id revocation** — kill one project's access by key-id without touching the others; secrets are stored only as `sha256` hashes and compared in constant time.
- **Supply chain** — Dependabot ([config](.github/dependabot.yml)), [CodeQL](.github/workflows/codeql.yml) static analysis, and an [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/elzinko/claude-proxy).
- **Tokens in Redis** — OAuth tokens live in Upstash Redis (Vercel) or a local file (local mode), not in the repo.
- **Client monitoring** — an optional `/api/clients` dashboard shows one row per client (keyed by `sha256(api_key + ip)`) so you can spot unauthorized key use; set `IPINFO_TOKEN` to resolve each IP to its host/ASN.

## Tests & coverage

`npm test` runs **150 passing** unit + integration tests (typechecked in CI, job *Unit tests + typecheck*). `npm run coverage` reports **~32% v8 line coverage** — an honest undercount: it measures only the unit + integration suites, so the server and route entry points (`src/server.ts`, `src/routes/**`), which are exercised by the integration-shell suite (`tests/integration-tests.sh`) and the live two-call cache regressions (`tests/live/**`), do not register in that number.

---

## Prompt caching

The proxy automatically places Anthropic `cache_control: {type: "ephemeral"}` breakpoints on the stable parts of each request:

- one marker on the **last block of `system`** (caches tools + system together)
- one marker on the **last tool** (partial hit if only system text changes)

Repeat calls with the same tools + system then hit the prompt cache at ~10% of the input price. For large clients like openclaw (22 KB system + 23 KB tools) this covers the majority of input tokens — the savings compound every turn.

**Verifying cache activity** — the proxy propagates Anthropic's counters both in response headers and in the OpenAI-compat response body:

```bash
curl -sS -D - -H "Authorization: Bearer $API_KEY" \
     -d @payload.json "$PROXY_URL/v1/chat/completions" | head -20

# Response headers of interest:
#   x-cache-control-injected: 2          ← bp count the proxy placed
#   x-cache-control-system:   1          ← marked the last system block
#   x-cache-control-tools:    1          ← marked the last tool
#   x-anthropic-cache-creation: 5120     ← tokens written this call (~1.25× rate)
#   x-anthropic-cache-read:     0        ← first call, nothing to read

# Response body carries the same numbers for OpenAI-compat clients:
#   "usage": {
#     "prompt_tokens": 5170,
#     "completion_tokens": 10,
#     "total_tokens": 5180,
#     "prompt_tokens_details": {
#       "cached_tokens": 0,
#       "cache_creation_tokens": 5120
#     }
#   }
```

Replaying the same curl 200 ms later should flip `cache_creation` to 0 and `cache_read`/`cached_tokens` to the same 5120. If `cached_tokens` stays at 0 across two identical requests, a silent invalidator is at work (timestamp in the system prompt, non-deterministic JSON key order, varying tool set). See [`shared/prompt-caching.md`](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) for the audit checklist.

**Respecting the client** — if the client already placed its own `cache_control` anywhere in `system`, `tools`, or message blocks, the proxy leaves the corresponding section alone (`x-cache-control-skip-reason: client_owns_system` or `client_owns_tools`). Max 4 breakpoints per request; the proxy never pushes the total over 4.

**Escape hatches** (env vars, no code change):

| Variable | Effect |
|---|---|
| `DISABLE_CACHE_CONTROL=1` | Skip injection entirely — use to rule out caching during an unrelated bug hunt |
| `CACHE_TTL_1H=1` | Use the 1-hour TTL instead of the 5-minute default. Write cost goes from 1.25× to 2× of base — break-even needs ≥3 reads per write. Worth enabling only for long openclaw-style sessions where the 5-min default keeps expiring between turns. |

**Streaming** — cache metrics arrive in the final `usage` chunk of the stream (same OpenAI-compat `prompt_tokens_details` shape). The response-header mirror is not populated for streaming responses because headers are flushed before usage numbers arrive from Anthropic.

**End-to-end probes against real openclaw payloads** — the in-repo tests use synthetic ~5 KB fillers (Haiku-friendly, deterministic, safe to commit). For E2E validation against **real openclaw traffic** (22 KB system prompt, 23 KB tools, multi-turn `tool_use`/`tool_result` histories — patterns that can introduce silent cache invalidators a synthetic payload can't reproduce), use the companion repo: **[claude-proxy-probe](https://github.com/elzinko/claude-proxy-probe)**. It ships five bash strategies (`01-auth-smoke` → `05-silent-invalidator-diff`) and is designed to run against a deployed preview/prod with fixtures kept out of version control.

---

## Docs

- [Deployment Guide](docs/DEPLOYMENT.md) — Vercel setup, Redis, environment variables
- [Cursor Setup Guide](docs/SETUP.md) — Model names, Cursor configuration
- [User Guide](docs/USER_GUIDE.md) — How to call the proxy (for users and LLMs)
- [FAQ](docs/FAQ.md) — Common questions and issues

---

## ☕ Support

If this saved you an API bill, you can [buy me a coffee](https://buymeacoffee.com/elzinko).

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Anthropic or Cursor.
