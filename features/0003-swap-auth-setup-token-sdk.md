---
id: 0003
title: Swap auth vers claude setup-token + ANTHROPIC_AUTH_TOKEN + SDK officiel
type: refactor
priority: P2
epic: 0005
status: todo
ready:
pr:
created: 2026-08-01
---

# 0003 — Swap auth vers claude setup-token + ANTHROPIC_AUTH_TOKEN + SDK officiel

## Contexte / Problème

Aujourd'hui le proxy **ré-implémente à la main le flow OAuth de Claude Code**
(`claude.ai/oauth/authorize` + `console.anthropic.com/v1/oauth/token`, PKCE,
CLIENT_ID pinné, refresh, stockage Redis) dans `src/auth/oauth-flow.ts` /
`oauth-manager.ts` + toute la surface `/auth/*`. C'est **fragile** (si Anthropic
change l'OAuth, ça casse et on maintient tout) et ça **augmente la surface
d'attaque** (dont le `/auth/logout` non-authentifié — cf. [[0004-kill-switch-gardien]]).

samplerz (ADR-024) fait plus simple et plus propre : `claude setup-token`
(login navigateur officiel) imprime un token d'abonnement `sk-ant-oat…`, rangé
dans l'env, consommé par le SDK officiel via `ANTHROPIC_AUTH_TOKEN`
(→ `Authorization: Bearer` + header `anthropic-beta: oauth-2025-04-20`).

## Proposition

Remplacer la sous-couche auth (pas le proxy — Cursor exige toujours un endpoint
OpenAI-compat public) :

- `claude setup-token` en local → coller le `sk-ant-oat…` dans `ANTHROPIC_AUTH_TOKEN` (env Vercel)
- appels via `@anthropic-ai/sdk`
- **supprimer** `oauth-flow.ts`, `oauth-manager.ts`, le store Redis de tokens, la
  logique de refresh, et la surface `/auth/*`

## Critères d'acceptation

- [ ] Le proxy authentifie via `ANTHROPIC_AUTH_TOKEN` (plus de flow OAuth maison)
- [ ] Le code OAuth + refresh + store Redis-token est supprimé
- [ ] Token expiré → 401 explicite (voir [[0002-reponse-401-explicite-token-doc]]) au lieu d'un échec opaque
- [ ] README documente la génération du token et le re-mint périodique

## Notes / décisions

- 2026-08-01 : approche validée par l'utilisateur ("ok je suis d'accord").
- **Trade-off à trancher au grooming** : setup-token n'est **pas** auto-refresh
  quand passé en env var (confirmé — le SDK ne rafraîchit un token que via un
  profil `ant auth login` sur disque, impossible en serverless). Donc on perd le
  refresh automatique actuel → re-mint **manuel** à l'expiration. Le 401 explicite
  ([[0002-reponse-401-explicite-token-doc]]) rend ce compromis acceptable. Décider :
  garder un refresh maison, ou assumer le re-mint manuel.
- 2026-08-01 : l'utilisateur **veut l'auto-refresh** → privilégier l'option 2
  (garder un refresh mince : stocker le `refresh_token`, POST du grant) plutôt que
  setup-token-en-env pur (qui perd l'auto-refresh en serverless). google-mcp ne
  fournit **aucun** code de refresh (délégué au CLI `gws`) → rien à copier là-dessus,
  c'est du maison. Rattaché à l'épic [[0005-gestion-tokens-mcp-elicitation]].
- **Vigilance CGU** : servir une API OpenAI-compat générique avec un token
  d'abonnement Pro/Max est une **zone grise** — garder l'usage **strictement
  mono-utilisateur** + disclaimer README.
