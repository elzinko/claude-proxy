---
id: 0005
title: Gestion des tokens claude-proxy via MCP à élicitation forte
type: epic
priority: P1
status: todo
ready:
pr:
created: 2026-08-01
---

# 0005 — Gestion des tokens claude-proxy via MCP à élicitation forte

> **Épic — non tirable directement.** Le travail buildable vit dans les enfants
> ([[0006-mcp-controle-tokens]], [[0002-reponse-401-explicite-token-doc]],
> [[0003-swap-auth-setup-token-sdk]], [[0004-kill-switch-gardien]]).

## 🎯 Goal

Faire de **claude-proxy** un proxy où :

1. **Démarrer un projet = générer un token dédié en quelques secondes**, via une
   **procédure affichée** (facilement/rapidement intégrable).
2. Les tokens **s'auto-rafraîchissent** (pas de re-collage manuel au quotidien).
3. On peut **révoquer vite — un projet précis OU tout** — via un **MCP à
   élicitation forte** : l'humain confirme dans un canal de confiance, et le
   **LLM n'a jamais la main** sur l'action privilégiée.

## Contexte / Problème

Aujourd'hui le proxy a **un seul `API_KEY` partagé** pour tous les clients : pas
de granularité (on ne peut pas couper *un* projet sans casser les autres), pas de
génération à la demande, pas de révocation ciblée, et le contrôle passe par des
routes HTTP (`/auth/*`) dont au moins une (`/auth/logout`) est **non
authentifiée** (finding HIGH, backlog sécu aegiz). Le repo étant **public**, il
faut un modèle de tokens propre, simple et révocable.

## Deux couches de tokens (à ne pas confondre)

| Couche | C'est quoi | "Révoquer" veut dire |
|---|---|---|
| **Aval — clés par appli** | Ce que chaque projet/client présente au proxy (aujourd'hui l'`API_KEY` unique). Cible : **une clé par appli**, émise à la demande. | Invalider la clé d'une appli (ou toutes) côté proxy → cette appli ne peut plus appeler le proxy. |
| **Amont — abonnement Claude** | Le token OAuth/abonnement (un seul, le tien) que le proxy utilise pour parler à Anthropic. | Révoquer l'app chez Anthropic + re-mint. **Seul vrai kill d'un token amont fuité.** |

« Révoquer par appli » = couche **aval**. « Révoquer pour tout » = toutes les clés
aval **et/ou** couper l'amont. Le kill-switch doit couvrir les deux.

## Principes (non négociables)

- **Le LLM n'autorise jamais** une action privilégiée (mint, revoke, add). Il peut
  la *proposer* ; l'humain la *confirme* hors du canal LLM.
- **Déterministe** sur le chemin critique de révocation (scripts/crypto, pas de LLM).
- **Fail-closed** : élicitation forte activée mais non satisfaite → refus, jamais
  d'approbation silencieuse.
- **Mono-utilisateur** assumé (zone grise CGU des abonnements Pro/Max) + disclaimer.

## Approche technique (inspirée de `google-mcp-multi-account`)

Repris de ton projet (voir enfant [[0006-mcp-controle-tokens]] pour le détail) :

- **« Propose-command, never execute »** : l'outil MCP `access_request`
  (`gateway/api.py:608`) renvoie la commande exacte à lancer par l'humain et
  **n'exécute rien**. Le LLM ne voit qu'une chaîne de texte.
- **Élicitation signée** (`gateway/elicitation.py`) : payload canonique lié à
  l'action + nonce anti-rejeu + signature (Touch ID/ECDSA-P256 sur Mac, **mock HMAC**
  cross-platform/CI), vérification + receipt côté serveur, gate fail-closed
  (`ADR-0005`). **Plus fort que l'élicitation MCP native** : la confirmation ne
  transite jamais par le transport du modèle. Même *désactiver* la garde est gaté.
- **Broker** (`gateway/broker_server.py`) : un seul process détient les creds et
  **re-vérifie policy/lock avant chaque appel** amont.
- **Vault 0700/0600** (`gateway/vault.py`) : secrets hors du répertoire lisible par l'agent.

**Adaptation clé pour Vercel** : le proxy (data plane) tourne en serverless Linux —
pas de Touch ID côté serveur. Donc le **MCP de contrôle tourne EN LOCAL** (ta
machine) et pilote une **API admin** du proxy pour mint/revoke ; l'élicitation +
biométrie restent **locales**. Le serveur ne fait qu'appliquer des ordres signés.

**Ce qui NE se transfère pas** (à ne pas copier) : tout le token-refresh est
délégué au CLI `gws` chez google-mcp → **il n'y a pas de refresh à reprendre** ;
claude-proxy doit garder/faire son **propre `refresh_token` grant** (cf. [[0003-swap-auth-setup-token-sdk]]).
Idem : Keychain/Secure Enclave/Touch ID sont macOS-only (fallback = mock HMAC).

## Écart à combler vs google-mcp

Chez google-mcp la révocation est **asymétrique** : delete par compte existe, mais
le geste global est un **lock-all** (réversible, garde les tokens), pas un vrai
« revoke-all ». claude-proxy **veut un vrai global revoke** (aval : purge des clés ;
amont : runbook de révocation Anthropic). À concevoir explicitement dans [[0004-kill-switch-gardien]].

## Enfants (le buildable)

- [[0006-mcp-controle-tokens]] — **cœur** : registre de clés **par appli** + MCP local (mint/list/revoke) + gate d'élicitation signée. (P1)
- [[0004-kill-switch-gardien]] — sémantique de révocation (par appli / global / amont) + fix `/auth/logout` + invariants no-LLM/déterministe. (P1)
- [[0002-reponse-401-explicite-token-doc]] — la **procédure affichée** (401 explicite → comment générer/fournir un token). (P2)
- [[0003-swap-auth-setup-token-sdk]] — fondation auth amont + **auto-refresh**. (P2)

## Non-goals

- Multi-tenant public / revente d'API (reste mono-utilisateur).
- Remplacer le proxy OpenAI-compat (Cursor exige un endpoint HTTPS public — inchangé).

## Questions ouvertes (à trancher au grooming)

- [ ] Clés aval : format (opaque aléatoire ? JWT signé ?), stockage (Redis existant ? vault ?), et rattachement `sha256(api_key+ip)` du dashboard actuel.
- [ ] MCP local : SDK MCP officiel ou skeleton stdio zéro-dépendance (comme google-mcp) ?
- [ ] Élicitation : réutiliser tel quel `gateway/elicitation.py` (Touch ID + mock) ou repartir d'un gate plus simple pour V1 ?
- [ ] Auto-refresh amont : garder l'OAuth+refresh maison actuel, ou setup-token + boucle de refresh maison (cf. 0003) ?
- [ ] « Révoquer tout » inclut-il l'amont (kill abonnement) par défaut, ou uniquement l'aval avec l'amont en option explicite ?
- [ ] ADR à écrire (frontière de confiance, modèle de menace) — sur le modèle d'`ADR-0005` de google-mcp.

## Notes / décisions

- 2026-08-01 : épic créé sur demande explicite ("créer une PR pour qu'on puisse la
  groomer tout de suite — c'est très important"). Goal fixé par l'utilisateur.
- Limite honnête à documenter : l'élicitation contrôle le comportement *coopératif*,
  pas la *capacité brute* — un agent avec un shell libre peut contourner la
  passerelle. Le vault + garder le secret hors du canal LLM sont l'atténuation.
