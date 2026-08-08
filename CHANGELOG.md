# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-08

### Added

- **Passkeys / WebAuthn admin authentication** — enroll a passkey and unlock the
  owner admin plane with Touch ID / platform biometrics; discoverable credentials,
  user-verification required, single-owner model (feature `0009`).
- **Per-app API-key registry** — mint a distinct key per project (`POST /api/keys`),
  list metadata, and revoke by key-id without rotating the others; secrets stored
  only as `sha256` hashes and compared in constant time (feature `0006` V1).
- **Global revoke-all kill switch** plus a documented revocation runbook in
  [`SECURITY.md`](SECURITY.md) (feature `0004`).
- **Explicit, actionable `401`/`500` responses** so misconfiguration is
  self-diagnosing instead of opaque (feature `0002`).

### Changed

- **Project renamed** `cursor-claude-connector` → **`claude-proxy`** across the repo,
  package manifests, docs, and GitHub project.
- **Production domain** is now `elzinko-claude-proxy.vercel.app` (the Vercel project
  was renamed and the domain swapped).

### Security

- **Fail-closed authentication** — with no auth source configured (no `API_KEY` and
  no key registry) the proxy refuses every request; the admin plane denies when
  `ADMIN_SECRET` is unset.
- **Admin plane separation** — OAuth setup, key mint/revoke, and cross-app telemetry
  reads sit behind a distinct `ADMIN_SECRET`, never reachable with a client key.
- **OAuth callback CSRF protection** via a single-use server-side `state`.
- **Redis rate limiter keyed by key-id**, upstream response-header allowlisting, and
  redaction of OAuth tokens from error propagation (feature `0008`).

> ⚠️ The production-domain change rotates the **WebAuthn RP-ID**. Passkeys enrolled
> against the old domain must be **re-enrolled** on `elzinko-claude-proxy.vercel.app`.

## [1.0.0] - 2026-02-23

### Added

- **OpenAI-compatible proxy** bridging Cursor IDE to a Claude Pro/Max subscription:
  accepts OpenAI-format requests, authenticates to Claude over **OAuth 2.0 + PKCE**,
  and forwards to the Anthropic API — no separate Anthropic API key.
- Endpoints: `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/models`.
- **Automatic Anthropic prompt-cache breakpoints** on the stable parts of each
  request (system + tools), with response-header and body cache counters and env
  escape hatches (`DISABLE_CACHE_CONTROL`, `CACHE_TTL_1H`).
- **Single-page status dashboard** with per-client monitoring and optional IP
  provenance (ASN + host) enrichment.
- **Vercel deployment** with Upstash Redis token storage (local-file fallback for
  dev), a `vitest` unit + integration suite, and a CI pipeline (tests, production
  smoke, CodeQL, Dependabot).

[1.1.0]: https://github.com/elzinko/claude-proxy/releases/tag/v1.1.0
[1.0.0]: https://github.com/elzinko/claude-proxy/releases/tag/v1.0.0
