---
id: 0007
title: Brique SDK — passthrough Anthropic natif + base_url + clé par appli
type: feature
priority: P1
epic: 0005
status: todo
ready:
pr:
created: 2026-08-01
---

# 0007 — Brique SDK : passthrough Anthropic natif + `base_url` + clé par appli

> Enfant de l'épic [[0005-gestion-tokens-mcp-elicitation]] · surface **B** de
> [ADR-0001](../docs/adr/ADR-0001-noyau-auth-elicitation-surfaces-livraison.md).
> Répond à : « comment un nouveau projet qui appelle Claude **via le SDK** réutilise
> une brique de ce projet, sans réimplémenter l'auth abonnement (+ élicitation) ? »

## Contexte / Problème

Plusieurs projets perso appellent déjà Claude **via le SDK officiel** (ex. samplerz :
`ANTHROPIC_AUTH_TOKEN` + SDK `anthropic`). Aujourd'hui chacun détient **son propre
token d'abonnement** → **blast radius** maximal et révocation « tout ou rien ». On
veut une **brique déjà développée** que chaque nouveau projet consomme.

## Proposition — la brique = SDK officiel + `base_url` + clé par appli

Le SDK Anthropic officiel supporte nativement **`ANTHROPIC_BASE_URL`** + un token.
Donc la brique n'est **quasiment pas du code** :

1. Le proxy expose un **passthrough Anthropic natif** `POST /v1/messages` (format
   Anthropic, pas OpenAI), authentifié par une **clé par appli**, qui forwarde vers
   `api.anthropic.com` avec le **token amont côté serveur**.
2. Un nouveau projet fait, dans **n'importe quel langage** :
   ```bash
   export ANTHROPIC_BASE_URL="https://<claude-proxy>/"
   export ANTHROPIC_AUTH_TOKEN="<clé_par_appli>"   # → Authorization: Bearer
   ```
   puis utilise le **SDK officiel normalement** (`client.messages.create(...)`).

**Le token d'abonnement ne quitte jamais le serveur.** Chaque projet ne détient
qu'une **clé aval révocable par appli** (cf. [[0006-mcp-controle-tokens]], [[0004-kill-switch-gardien]]).

## Optionnel (durcissement) — onboarding + élicitation

- Un mince helper par langage qui, au **premier run**, récupère la clé par appli via
  le **MCP local** (mint **élicité** → l'humain confirme) et l'écrit dans l'env.
- Pour les projets qui veulent **eux-mêmes** gater des actions privilégiées : exposer
  l'élicitation du MCP local comme dépendance réutilisable.

## Critères d'acceptation

- [ ] `POST /v1/messages` en **format Anthropic natif** fonctionne avec le SDK officiel via `base_url`
- [ ] Auth par clé par appli (Bearer) ; une clé révoquée est refusée
- [ ] Le token amont n'est **jamais** renvoyé au client (audit d'un dump de réponse)
- [ ] Un projet SDK démarre en **2 variables d'env** (procédure affichée, cf. [[0002-reponse-401-explicite-token-doc]])
- [ ] Parité minimale avec la surface OpenAI-compat : streaming, `cache_control`, betas

## Review adverse (2026-08-01) — ⚠️ casse le « quasi un forward »

- **Vrai bug** : le passthrough **préfixe** « You are Claude Code… » au system prompt
  de l'appelant (`server.ts:1067` ; origine détectée sur `system[0]`). On ne peut pas
  garder le marker requis par l'abonnement **ET** le prompt appelant verbatim → « base_url
  + token, tout langage » **change le comportement du modèle en silence**.
- **Fuite d'identité d'org** : headers amont renvoyés quasi verbatim (`server.ts:888,987`)
  → `anthropic-organization-id`, `request-id` ([[0008-durcissement-securite-trous-live]] TL8).
- **Escalade CGU** : une API Anthropic **native générique** sur abonnement, pour N
  programmes headless, ressemble **plus** à de la revente que le cas Cursor.

**Arbitrage PO (surface B)** : **différer** cette fiche, ou en faire un **shim par langage
honnête** (qui possède le marker/beta/UA + allowlist de headers, ≈ Option C de l'ADR) **+
scope localhost/1 projet** — pas une brique « pointe tous tes projets ici ». **Ne pas
poser `ready` avant cet arbitrage.**

## Notes / décisions

- 2026-08-01 : issu de la question ouverte de l'utilisateur ; tranché en surface **B**
  de l'ADR-0001 (Option B : noyau + surfaces). Alternative « packages par langage »
  (Option C) **différée** — `base_url` donne le cross-langage sans package.
- Rend le proxy **point de passage critique** du trafic SDK → soigner dispo/latence/observabilité (conséquence ADR-0001).
