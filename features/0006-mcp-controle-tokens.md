---
id: 0006
title: MCP local de contrôle — mint/list/revoke des tokens par appli + élicitation signée
type: feature
priority: P1
epic: 0005
status: todo
ready:
pr:
created: 2026-08-01
---

# 0006 — MCP local de contrôle : mint/list/revoke des tokens par appli + élicitation signée

> Enfant de l'épic [[0005-gestion-tokens-mcp-elicitation]]. C'est le **cœur
> buildable** : le registre de clés par appli + le plan de contrôle MCP local.

## Contexte / Problème

Le proxy n'a qu'un `API_KEY` partagé : impossible de générer une clé dédiée par
projet ni d'en révoquer une seule. Il faut un **plan de contrôle** qui émet et
révoque des **clés par appli**, où chaque geste privilégié est **confirmé par
l'humain hors du canal LLM**.

## Proposition

### a) Registre de clés **par appli** (data plane, dans le proxy)

- Chaque appli/projet reçoit **sa** clé aval (opaque aléatoire), avec métadonnées
  (`label`, `created`, `last_used`, `status: active|revoked`).
- Le middleware `require-api-key` valide contre le **registre** (plus une seule clé
  en env). Se branche sur le dashboard clients existant (`sha256(api_key+ip)`).
- Stockage : Redis Upstash déjà en place (ou vault dédié — cf. question ouverte 0005).
- **API admin** minimale sur le proxy (mint/list/revoke), protégée par un **secret
  admin distinct** de l'`API_KEY` client — appelée **uniquement** par le MCP local.

### b) MCP **local** de contrôle (control plane, sur ta machine)

Outils MCP exposés (le LLM peut les *appeler pour proposer*, jamais pour *exécuter*
sans élicitation) :

| Outil | Effet | Élicitation |
|---|---|---|
| `token_list` | liste les clés (label, statut, dernier usage) | non (lecture) |
| `token_mint <label>` | génère une clé par appli + **renvoie la procédure d'intégration affichée** (cf. [[0002-reponse-401-explicite-token-doc]]) | **oui** |
| `token_revoke <label>` | révoque **une** appli | **oui** |
| `token_revoke_all` | révoque **toutes** les clés aval (+ option amont) | **oui (forte)** |
| `status` | diagnostic auth amont + expiries | non |

### c) Gate d'élicitation signée (repris de google-mcp)

- Modèle **« propose-command, never execute »** : l'outil renvoie la commande/action
  à confirmer ; **rien ne s'exécute** tant que l'humain n'a pas signé.
  (réf. `gateway/api.py:608`, schéma `gateway/mcp_server.py:296`.)
- Réutiliser `gateway/elicitation.py` : payload canonique lié à l'action + **nonce
  anti-rejeu** + signature (Touch ID/ECDSA-P256 sur Mac, **mock HMAC** en CI/Linux) +
  vérification + **receipt** d'audit + **fail-closed** (réf. `ADR-0005`).
- Le LLM ne voit qu'une chaîne ; il ne peut ni voir, ni forger, ni rejouer la
  confirmation. Même désactiver la garde est gaté.

## Critères d'acceptation

- [ ] `token_mint` crée une clé par appli et renvoie la procédure d'intégration prête à coller
- [ ] Une clé aval révoquée est refusée par le proxy en < quelques secondes
- [ ] `token_revoke` (une appli) n'affecte pas les autres ; `token_revoke_all` les coupe toutes
- [ ] Aucune action privilégiée (mint/revoke) ne s'exécute sans élicitation satisfaite (fail-closed vérifié)
- [ ] Le LLM ne peut PAS mint/revoke seul (test : appel outil → propose, n'exécute pas)
- [ ] L'API admin du proxy exige le secret admin (≠ clés clients) ; `/auth/logout` idem (cf. [[0004-kill-switch-gardien]])
- [ ] Chemin mock HMAC fonctionnel hors macOS (CI)

## Dépendances externes

- **Repo `google-mcp-multi-account`** (source des patterns élicitation/broker/vault) —
  accès **constaté le 2026-08-01** (`/Users/elzinko/git/google-mcp-multi-account`,
  analysé : `gateway/elicitation.py`, `gateway/api.py`, `gateway/mcp_server.py`,
  `gateway/vault.py`, `gateway/broker_server.py`, `docs/adr/ADR-0005-elicitation-signee-v2.md`).

## Notes / décisions

- Adaptation Vercel : le MCP + l'élicitation/biométrie sont **locaux** ; le proxy
  serverless ne fait qu'appliquer des ordres signés via l'API admin (pas de Touch ID
  côté serveur). Voir [[0005-gestion-tokens-mcp-elicitation]].
- V1 possible sans biométrie : gate mock HMAC / secret admin, Touch ID en durcissement.
