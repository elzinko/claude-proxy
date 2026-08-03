---
id: 0006
title: MCP local de contrôle — mint/list/revoke des tokens par appli + élicitation signée
type: feature
priority: P1
epic: 0005
status: todo
ready: 2026-08-03
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

### d) Auth forte = WebAuthn / passkeys (recommandé, 2026-08-03)

Concrétise l'« empreinte pour valider une action » : au lieu du Touch ID
**macOS-only** + MCP local de google-mcp, utiliser **WebAuthn / passkeys** (standard
FIDO2) sur la **page d'admin** :

- Tu enregistres **une passkey une fois** (Touch ID / Face ID / clé physique) ; la clé
  privée vit dans le Secure Enclave, **non-exportable** → satisfait **MF7**.
- Chaque **mint/revoke** exige une **assertion WebAuthn** (geste biométrique) que le
  serveur vérifie. **Anti-phishing** ; le LLM **ne peut pas** la produire (présence
  utilisateur matérielle).
- **Cross-device** (dans le navigateur, pas juste sur ton Mac) — bien mieux adapté à un
  proxy hébergé sur Vercel que le Touch ID local. Challenge stocké en Redis (comme le
  `state` OAuth de #17). Lib : `@simplewebauthn/server`.

**Implication à confirmer (PO)** : pour le cas courant « **je** démarre un projet et je
mint un token », **page d'admin + passkey suffit** → le **MCP devient optionnel** (utile
seulement si un *agent autonome* doit **demander** un mint : MCP = « propose », toi =
« approve » via passkey). Ça **simplifie la V1** : `ADMIN_SECRET` (fait, #17) + **passkey**
sur les actions destructrices + registre de clés ; MCP en durcissement/plus tard.

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

## Review adverse (2026-08-01)

Must-fix de [ADR-0001](../docs/adr/ADR-0001-noyau-auth-elicitation-surfaces-livraison.md) à intégrer :
- **MF5** — `token_mint` **ne renvoie JAMAIS la clé** au canal LLM (seulement un pointeur `key show <label>` en terminal local) ; sinon le modèle lit le secret → casse « propose-command, never execute ». Test : dump du résultat d'outil → 0 matériel de clé.
- **MF6** — nonce anti-rejeu en **Redis `SET NX EX`** (google-mcp = fichier local mono-instance → **rejouable** en serverless multi-instance) ; **signature obligatoire** à l'apply (secret admin = transport, jamais suffisant) ; payload lié **key-id + compteur de génération + TTL** (anti-TOCTOU).
- **MF7** — « le LLM n'a jamais la main » n'est vrai que pour un LLM **coopératif dans le canal MCP** ; shell/même-UID contourne (V1 mock-HMAC signable par le proposeur). Claim fort ⇒ clé **non-exportable Secure Enclave** + shell agent durci.
- **MF1** — révocation **par key-id** (cf. [[0004-kill-switch-gardien]]).

**Arbitrage PO (ambition V1)** : un reviewer juge ce plan de contrôle **sur-dimensionné** — il garde le secret *pas cher* (clés aval révocables), pas le secret *cher* (token amont, non protégeable par élicitation, shell bypass). Option : **V1 = `/admin/keys` derrière un secret admin** (registre key-id + fail-closed) ; **élicitation signée + biométrie = V2 (durcissement)**.

## Notes / décisions

- Adaptation Vercel : le MCP + l'élicitation/biométrie sont **locaux** ; le proxy
  serverless ne fait qu'appliquer des ordres signés via l'API admin (pas de Touch ID
  côté serveur). Voir [[0005-gestion-tokens-mcp-elicitation]].
- V1 possible sans biométrie : gate mock HMAC / secret admin, Touch ID en durcissement.
