---
id: 0004
title: Kill-switch / gardien authentifié pour révoquer tous les tokens
type: feature
priority: P1
epic: 0005
status: shipped
ready:
pr: "#31"
created: 2026-08-01
---

# 0004 — Kill-switch / gardien authentifié pour révoquer tous les tokens

## Contexte / Problème

Si quelqu'un s'infiltre sur le serveur et **copie les tokens**, on veut pouvoir
"tout éteindre / reset". Point crucial : **reset le stockage local ne tue PAS la
copie que l'attaquant détient** — seule la **révocation en amont chez Anthropic**
invalide un token fuité.

Aggravant : `/auth/logout` est aujourd'hui **non authentifié** (finding HIGH du
backlog sécu aegiz) → n'importe qui peut déjà wiper les tokens. C'est l'inverse
d'un gardien.

## Proposition

Un gardien **déterministe (scripts), PAS un LLM** dans le chemin critique (un
kill-switch doit être auditable et non-injectable ; un LLM ajoute surface
d'attaque + non-déterminisme). Composants :

1. **Kill-switch authentifié** (endpoint/script, protégé par un secret admin
   distinct de l'`API_KEY` client) qui : (a) wipe les creds stockés, (b) fait
   tourner l'`API_KEY` du proxy.
2. **Runbook de révocation amont** (le vrai kill d'un token copié) : révoquer
   l'autorisation de l'app chez Anthropic (claude.ai → apps connectées) puis
   re-mint (`claude setup-token`). Documenté.
3. **Réduction du blast radius** : mono-utilisateur ; token en env (pas dans un
   store requêtable) ; courte durée quand possible.
4. **Fix `/auth/logout` non-auth** (HIGH) — l'exiger derrière le secret admin.
5. *(optionnel)* Détection : le dashboard clients + IP-provenance existent déjà ;
   un LLM peut servir de **triage** des lignes suspectes — analyste, pas gardien.

## Critères d'acceptation

- [ ] `/auth/logout` (et tout reset) exige un secret admin (≠ `API_KEY` client)
- [ ] Un kill-switch fait tourner l'`API_KEY` et wipe les creds en une action
- [ ] Runbook de révocation amont écrit et testé (le token copié cesse de marcher)
- [ ] Aucun LLM dans le chemin du kill-switch

## Review adverse (2026-08-01)

Absorbe des **must-fix** de [ADR-0001](../docs/adr/ADR-0001-noyau-auth-elicitation-surfaces-livraison.md) :
- **MF1** — révoquer sur le **key-id**, dans `require-api-key`, sur **toutes** les routes (admin incluse). ⚠️ **Ne PAS** enforcer sur `sha256(api_key+ip)` (self-unrevoke + dodge par IP/XFF) — ce fingerprint = **affichage seul**.
- **MF2** — `/api/clients/*`, `/api/stats`, `/api/status/*` **et toutes** les mutations `/auth/*` derrière le secret admin (pas que `/auth/logout`).
- **MF3** — **fail-closed** : deny sur erreur Redis ; refus si registre vide.
- **MF4** — `/auth/oauth/callback` non-auth laisse **écraser** le token amont (pas juste le wiper).

Trous *live* correspondants → [[0008-durcissement-securite-trous-live]] (P0 : TL1/TL3/TL5).

## Notes / décisions

- Issu de la discussion archi/sécu du 2026-08-01. Rattaché à l'épic [[0005-gestion-tokens-mcp-elicitation]].
- **Frontière avec [[0006-mcp-controle-tokens]]** : 0006 = le *mécanisme* (outils MCP
  mint/list/revoke + gate d'élicitation) ; 0004 = les *garanties* (ce que « révoquer »
  invalide vraiment : aval par appli / aval global / amont via runbook Anthropic) +
  le fix du trou `/auth/logout`. « Révoquer par appli ou pour tout » vit ici.
- Se simplifie avec [[0003-swap-auth-setup-token-sdk]] (moins de creds à protéger,
  `/auth/*` disparaît).
- Recoupe le finding HIGH "unauth /auth/logout wipe" (backlog sécu aegiz).
