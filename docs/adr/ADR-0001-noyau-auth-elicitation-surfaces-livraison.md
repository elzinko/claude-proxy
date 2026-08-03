# ADR-0001 : Noyau "auth abonnement + élicitation", séparé de ses surfaces de livraison

**Status:** **Accepted** (2026-08-03) — amendé après review adverse (3 red-teamers, 2026-08-01) ; arbitrages PO tranchés : **élicitation signée dès la V1**, **surface B différée**. Les must-fix **MF1–MF7** sont des contraintes de build suivies dans 0004/0006.
**Date:** 2026-08-01
**Deciders:** elzinko (PO)
**Épic:** [0005](../../features/0005-gestion-tokens-mcp-elicitation.md) · **Fiches:** 0002, 0003, 0004, 0006, 0007, **0008 (trous live)**

## Context

claude-proxy fait passer un **abonnement Claude Pro/Max** vers des clients qui ne
sont pas Anthropic-natifs (Cursor, OpenAI-compat). Deux forces nouvelles :

1. **Multi-consommateurs & révocation.** Une **clé par appli** (générée en qq
   secondes, procédure affichée), **auto-refresh**, **révocation rapide par appli
   OU globale** — sans casser les autres projets.
2. **Réutilisation par les projets SDK.** Des projets appellent déjà Claude **via le
   SDK officiel** (ex. samplerz : `ANTHROPIC_AUTH_TOKEN` + SDK `anthropic`) et veulent
   réutiliser une **brique** au lieu de réimplémenter l'auth (+ élicitation).

Contraintes (dures) :

- **Le LLM n'a JAMAIS la main** sur une action privilégiée (mint/revoke/add) :
  élicitation « **propose-command, never execute** » + confirmation **signée hors du
  canal LLM** (inspiré de `google-mcp-multi-account`). **Déterministe / fail-closed.**
- **Vercel serverless** = FS éphémère, **pas de biométrie côté serveur** → *control
  plane* privilégié **en local**.
- **Mono-utilisateur** assumé (zone grise CGU) + disclaimer. Repo **public**.

## Decision

Structurer en **un NOYAU indépendant de la livraison** + **des SURFACES** au-dessus,
avec un **control plane local** pour tout ce qui est privilégié.

**NOYAU (delivery-agnostic, serveur)** : auth amont (token unique, **auto-refresh**
`refresh_token` grant, jamais exposé aux clients) · **registre de clés aval par appli**
(opaques, **hachées**, révocables **par key-id**) · **gate d'autorisation** (mint/revoke
ne s'exécutent qu'après ordre **signé** hors-LLM) · audit · **default-deny / fail-closed**.

**SURFACES** : **A — Proxy OpenAI-compat** *(existant)* · **B — Passthrough Anthropic
natif** *(la « brique SDK » — voir arbitrage ci-dessous)*.

**Control plane LOCAL** : MCP local (0006) portant l'élicitation signée, pilotant une
**API admin** du proxy (secret admin **≠** clés clients).

### Tranchage des questions de grooming (0005) — corrigé après review

- **Clés aval** : opaques aléatoires **≥256 bits** (réutiliser le CSPRNG du PKCE,
  `oauth-flow.ts:20`), **stockées hachées** (SHA-256), comparaison **constante**.
  **Révocation sur le key-id — PAS sur `sha256(api_key+ip)`** : ce fingerprint reste
  **purement affichage** (le lier à la révocation la casse — voir MF1). *(Corrige la
  version initiale de cet ADR qui disait « réconcilie le `sha256(api_key+ip)` ».)*
- **Auto-refresh amont** : côté serveur, `refresh_token` grant maison — **avec un lock
  Redis** (voir trou live TL4).
- **Global revoke** : *aval* = disable-all du registre (déterministe) ; *amont* =
  **runbook** manuel, **non garanti** de tuer un access token déjà émis avant `expires_in`.
- **MCP / élicitation** : voir arbitrage « ambition V1 ».

## Review adverse (2026-08-01) — 3 red-teamers, ancrés dans le code

**Verdict unanime : Amend — ne pas Accepter tel quel.** La *forme* (noyau + surfaces +
plan admin) tient (2 reviewers/3 la gardent), mais la révocation spécifiée est
**incomplète**, plusieurs **trous sont déjà live** dans le code déployé, et **2 choix
sont des arbitrages PO**. (Crédité correct : `x-debug-trace` n'échoit pas `authorization` ;
upstream hardcodé `api.anthropic.com` → pas de SSRF via `base_url` client ;
`redactUpstashError` scrube les tokens.)

### Must-fix avant `Accepted` (consensus)

| # | Must-fix | Pointeur |
|---|---|---|
| MF1 | **Révoquer sur le key-id**, appliqué dans `require-api-key` sur **toutes** les routes (admin incluse). Tue le self-unrevoke et le dodge par IP/XFF. | `client-tracker.ts:109`, `server.ts:484`, `clients.ts:45` |
| MF2 | **Séparer plan admin / plan client** : `/api/clients/*`, `/api/stats`, `/api/status/*` et **toutes** les mutations `/auth/*` derrière un **secret admin** distinct. Clé client = **inférence seule** (0 visibilité/contrôle sur les autres apps). | `clients.ts:7`, `stats.ts:8`, `status.ts:10` |
| MF3 | **Fail-closed partout** : révocation renvoie *deny* sur erreur Redis (aujourd'hui *allow*) ; **refus si registre vide sur toute plateforme** ; supprimer le bypass `API_KEY` env (clé maître non-révocable). | `client-tracker.ts:151`, `require-api-key.ts:21-40` |
| MF4 | **Authentifier tout `/auth/*`** — pas que `/auth/logout`. `/auth/oauth/callback` non-auth laisse **écraser** ton token amont par celui d'un attaquant (intégrité, pas juste DoS). | `server.ts:151,199,228` |
| MF5 | **`token_mint` ne renvoie JAMAIS la clé au canal LLM** — seulement un pointeur (`key show <label>` en terminal local). Sinon le modèle lit le secret → casse « propose-command, never execute ». | fiche 0006 |
| MF6 | **Ordres signés = état partagé + atomique** : nonce anti-rejeu en **Redis `SET NX EX`** (le modèle google-mcp = fichier local mono-instance → rejouable en serverless) ; **signature obligatoire** à l'apply (secret admin = transport, jamais suffisant) ; payload lié au **key-id + compteur de génération + TTL** (anti-TOCTOU). | fiche 0006 |
| MF7 | **Downgrade honnête de « le LLM n'a jamais la main »** : vrai seulement pour un LLM **coopératif confiné au canal MCP**. Shell/FS/même-UID contourne (V1 mock-HMAC signable par le proposeur ; clé fichier lisible même-UID). Claim fort ⇒ clé **non-exportable Secure Enclave** + shell agent durci. | fiches 0005/0006 |

### Trous LIVE à fermer MAINTENANT (repo public + déployé) → fiche [0008](../../features/0008-durcissement-securite-trous-live.md) (P0)

Exploitables aujourd'hui, indépendants de l'épic : wipe+**overwrite** non-auth du token
amont via `/auth/*` (MF4) · **open relay** de l'abonnement hors Vercel/mal configuré
(MF3) · révocation **fail-open** sur incident Redis (MF3) · **course au refresh** sans
lock → panne globale (`oauth-manager.ts:125-167`). Plus : limiteur en mémoire par-lambda +
collision de buckets, amplification IPINFO via XFF spoofé, fuite d'`anthropic-organization-id`
dans les headers renvoyés (surface B).

### Arbitrages PO ouverts (à trancher avant `Accepted`)

1. **Surface B / brique SDK (0007).** Les reviewers signalent : (a) **vrai bug** — le
   passthrough préfixe « You are Claude Code… » au system prompt de l'appelant
   (`server.ts:1067`) → change le comportement en silence, donc « base_url magique » est
   **faux** ; (b) fuite d'**identité d'org** via headers amont (`server.ts:888,987`) ;
   (c) **escalade CGU** (API native générique sur abonnement ≈ plus proche de la revente
   que le cas Cursor). → **Reco : différer B**, ou en faire un shim par langage *honnête*
   (qui possède le marker/beta/UA) + scope localhost/1 projet — **pas** « pointe tous tes
   projets ici ».
2. **Ambition V1.** Reviewer 3 : le MCP + élicitation signée protège le secret **pas cher**
   (clés aval révocables) alors que le secret **cher** (token amont) **ne peut pas** être
   protégé par l'élicitation (shell bypass). → **Reco : V1 = noyau minimal sûr** (registre
   key-id + secret admin + MF1–MF4, fail-closed) ; **élicitation signée + biométrie =
   durcissement V2** par-dessus. La *forme cible* reste ; c'est l'**ordre de livraison** qui
   change.

## Options Considered

### Option A : Monolithe proxy-only (statu quo étendu)

Clés par appli dans le proxy ; projets SDK gardent chacun **leur** token amont.

| Dimension | Assessment |
|-----------|------------|
| Complexité | Low · Sécurité (blast radius) | **Mauvais** (token amont dupliqué, revoke tout-ou-rien) · Réutilisation | **Nulle** |

**Cons:** ne répond pas à la demande « brique réutilisable ».

### Option B : Noyau + surfaces (proxy OpenAI-compat + passthrough SDK) — *recommandée sous réserve des arbitrages*

| Dimension | Assessment |
|-----------|------------|
| Complexité | Medium · Sécurité | **Bon** (token amont serveur-only, revoke par appli) · Réutilisation | **Forte** (mais voir bug marker + CGU, arbitrage 1) |

### Option C : Bibliothèques par langage (packages Python + TS)

| Dimension | Assessment |
|-----------|------------|
| Complexité | High (2× maintenance) · Sécurité | garde un token amont en process (blast radius) |

## Trade-off Analysis

Le pivot = **où vit le token amont**. En **B** il reste **serveur-only** ; les projets
n'ont que des **clés aval révocables** — *le* gain sécurité. **C** réintroduit le token
amont en process. **A** ne répond pas. **MAIS** la review montre que le coût de B a été
**sous-estimé** (le passthrough n'est pas « quasi un forward » : il porte le marker Claude
Code, la fuite d'identité, l'escalade CGU) → d'où l'arbitrage 1 (différer/scoper B), et
l'ordre V1-minimal → V2 (arbitrage 2).

## Consequences

- **Plus facile** : ajouter/révoquer un projet ; token amont hors des clients.
- **Plus dur** : le proxy devient **point de passage critique** (SPOF/latence/timeout à
  soigner — un reviewer note qu'on convertit N domaines de panne indépendants en un) ;
  deux surfaces à garder cohérentes.
- **À revisiter** : révocation **amont** = runbook manuel (résiduel = TTL de l'access
  token) ; la frontière « LLM ne contourne pas » n'est vraie qu'au **niveau coopératif**.

## Action Items

1. [~] **Fermer les trous live (fiche 0008, P0)** — **décidé 2026-08-02 (PO) : PR sécu urgente séparée, EN COURS** (TL1–TL4 + mutations admin ; relue avant merge).
2. [x] Passer l'ADR en review adverse.
3. [x] **Arbitrage PO 1** — **décidé 2026-08-03 (PO) : DIFFÉRER la surface B** (fiche 0007 → `idea`). Brique = clé aval + proxy OpenAI-compat pour l'instant ; pas de passthrough natif générique tant que le marker « You are Claude Code » et le risque CGU ne sont pas réglés.
4. [x] **Arbitrage PO 2** — **décidé 2026-08-02 (PO) : élicitation signée DÈS la V1.** Les must-fix restent obligatoires : MF5 (`token_mint` ne renvoie pas la clé au LLM), MF6 (nonce Redis atomique + signature obligatoire + binding key-id/génération/TTL), MF7 (claim « no-LLM » borné au canal coopératif ; clé non-exportable Secure Enclave pour un claim fort).
5. [ ] Intégrer MF1–MF7 comme contraintes de build dans 0004/0006 ; construire la V1 (registre key-id + plan admin + élicitation signée).
