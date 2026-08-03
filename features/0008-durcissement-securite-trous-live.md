---
id: 0008
title: Durcissement sécurité — trous live confirmés par la review adverse
type: bug
priority: P0
status: todo
ready:
pr:
created: 2026-08-01
---

# 0008 — Durcissement sécurité : trous live confirmés (review adverse)

> **P0 — le repo est public ET déployé.** Ces trous sont **exploitables aujourd'hui**,
> indépendamment de l'épic [[0005-gestion-tokens-mcp-elicitation]]. Confirmés par les 3
> red-teamers (2026-08-01), ancrés dans `src/`. Voir must-fix de
> [ADR-0001](../docs/adr/ADR-0001-noyau-auth-elicitation-surfaces-livraison.md).

## Statut (2026-08-02)

**TL1–TL4 livrés → [PR #17](https://github.com/elzinko/cursor-claude-connector/pull/17)** (branche `feat/0008-security-hardening`, off `main`) : auth admin sur `/auth/logout` + `/auth/login/start`, CSRF du callback OAuth par `state` serveur à usage unique, fail-closed si `API_KEY` absent + compare constant-time, `isRevoked` fail-closed, lock single-flight du refresh. Typecheck + 126 tests verts (+9). ⚠️ nouvel env **`ADMIN_SECRET`** requis ; bouton « Disconnect » de l'UI à mettre à jour.

**TL5 livré** (registre 0006 en #20 pour les **mutations** revoke/unrevoke ; **lectures** `/api/clients`, `/api/clients/daily`, `/api/stats/*`, `/api/status/full` passées **tier admin** + `/auth/status` info-leak réduit à `{authenticated, apiKeyConfigured}` hors admin → PR 0008-info-leak-tier). Dashboard non cassé (le champ était déjà le secret admin). **+6 tests (158).**

**TL8 livré** (allowlist des headers de réponse : seul `content-type` est transmis en aval ; `anthropic-organization-id`, `request-id`, `anthropic-ratelimit-*`, `cf-ray`, `set-cookie`… sont **droppés** → PR 0008-response-header-allowlist). Corrige au passage un `content-length` amont périmé transmis par le chemin transform OpenAI. **+2 tests (160).**

**Restants :** **TL6** (rate-limiter Redis par key-id — dépend d'un choix de politique de quotas), **TL7** (amplification IPINFO via XFF spoofé — skip pour bloqués/révoqués + cap par key-id) → follow-up. Décision produit en attente : quotas TL6 (proxy mono-utilisateur → rate-limiting surtout anti-emballement).

## Trous confirmés

| # | Trou | Impact | Pointeur | Fix |
|---|---|---|---|---|
| **TL1** | **`/auth/*` non authentifié** : `/auth/logout` wipe le token amont ; **`/auth/oauth/callback` l'écrase** par un token attaquant (il lance l'OAuth sur SON compte, POST `code+verifier`). | RCE-crédential : DoS **+ intégrité** (proxy tourne sur un token contrôlé par l'attaquant). | `server.ts:151,199,228` ; `oauth-flow.ts:114` | Auth **admin** sur toutes les mutations `/auth/*` ; `/auth/status` admin-only ou booléen nu. |
| **TL2** | **Open relay** : `validateApiKey` renvoie `ok` si `allowedKeys` vide, et le garde fail-closed ne s'arme que si `VERCEL===1 || NODE_ENV===production`. | Tout déploiement non-Vercel/mal configuré = **proxy ouvert** sur l'abonnement payant. | `require-api-key.ts:21-37` | Fail-closed **sur toute plateforme** si registre vide. |
| **TL3** | **Révocation fail-open** : sur exception Upstash, `isRevoked` renvoie `false` → autorisé. | Pendant un incident Redis, les clés révoquées/attaquantes **passent**. | `client-tracker.ts:151-154` | Sur erreur d'autz → **deny** (503/401) ; gate le fetch du token amont dessus. |
| **TL4** | **Course au refresh sans lock** : `refreshToken` fait read-modify-write des creds Redis partagés sans CAS ; deux cold-starts concurrents rafraîchissent, si Anthropic rotate le refresh_token → last-write-wins → **panne globale** jusqu'à re-auth navigateur. | Panne globale auto-infligée (aggravée par le trafic). | `oauth-manager.ts:125-167` | Lock Redis `SET NX EX` autour du refresh ; single-flight. |
| **TL5** | **admin == client** : `/api/clients` (list+revoke+unrevoke), `/api/stats`, `/api/status/full` derrière la **clé client**. | Dès >1 clé, toute appli **révoque/dox** les autres (IP/ASN/usage). | `clients.ts:7,45` ; `stats.ts:8` ; `status.ts:10` | Derrière le **secret admin** (cf. [[0004-kill-switch-gardien]]). |
| **TL6** | **Limiteur en mémoire par-lambda + buckets par split(`-`)** : `100/h` réel = 100×instances, reset au cold-start ; clés opaques sans `-` collapsent sur `default`. | Isolation coût/débit entre apps **fictive** ; une appli DoS le quota des autres. | `rate-limiter.ts:14` ; `request-logger.ts:74` | Limiteur **Redis** par **key-id** ; ne pas dériver l'identité d'un split de clé. |
| **TL7** | **Amplification IPINFO via XFF spoofé** : lookup provenance sur **chaque** requête (même bloquée), `ip` = XFF attaquant → épuise le quota IPINFO + gonfle Redis. | Coût $ + keyspace ; drivable par une clé **révoquée**. | `client-tracker.ts:208` ; `ip-provenance.ts:273,425` | Skip pour bloqués/révoqués ; valider IP réelle ; cap par key-id. |
| **TL8** | **Fuite d'identité d'org (surface B)** : headers amont renvoyés quasi verbatim → `anthropic-organization-id`, `request-id`. | Un porteur de clé aval relie les réponses au **compte** sous-jacent. | `server.ts:888-896,987-1000` | **Allowlist** de headers de réponse ; drop des headers client entrants sauf allowlist. |

## Runbook de réponse à incident (ordre : tuer d'abord les creds qui annulent les étapes suivantes)

1. **Freeze** (si outage OK) : flag global default-deny / désactiver le déploiement. *(Ne contient PAS un token amont copié — il marche en direct chez Anthropic.)*
2. **Roter les « watchers »** : `UPSTASH_REDIS_REST_TOKEN` → tokens deploy/CI Vercel → (si machine locale compromise) keypair de signature + re-pin pubkey → secret admin.
3. **Contenir l'AMONT** (joyau, lent, humain) : claude.ai → apps connectées → révoquer → re-mint sur un **nouveau** grant. Noter le résiduel (`expires_in`) ; un `invalid_grant` sur ton refresh = tripwire (une copie est vivante).
4. **Contenir l'AVAL** : disable-all du registre → re-mint le nécessaire ; **supprimer** la liste `API_KEY` env ; **redeploy** (purge des instances chaudes).
5. **Roter le matériel amont stocké** dans Redis (`auth:anthropic`) — *après* 2 seulement.
6. **Vérifier** sur une 2e instance chaude : clé révoquée refusée < SLA ; `/auth/*` + `/api/clients/*` refusent le non-admin ; révocation **fail-closed** (simuler erreur Redis → deny).

## Critères d'acceptation

- [ ] `curl -XPOST /auth/logout` et `/auth/oauth/callback` sans secret admin → **401**
- [ ] Registre vide sur toute plateforme → `/v1/messages` **jamais servi** (401/500)
- [ ] Erreur Redis simulée → révocation **deny** (fail-closed)
- [ ] Deux refresh concurrents → **un seul** grant effectif (lock), pas de panne
- [x] Clé client → **401** sur `/api/clients`, `/api/stats`, `/api/status/full` (tier admin) + `/auth/status` sans admin ne renvoie que `{authenticated, apiKeyConfigured}`
- [x] Réponse surface B → **aucun** `anthropic-organization-id` / `request-id` renvoyé (allowlist `content-type` uniquement)

## Notes / décisions

- 2026-08-01 : issu de la review adverse (3 agents). TL1/TL5 recoupent [[0004-kill-switch-gardien]] et le finding HIGH aegiz. TL4 est un bug de dispo pur (pas de la sécu d'accès) mais critique.
- **À traiter probablement en PR séparée et urgente** (avant même le build de l'épic) — arbitrage PO sur le timing.
