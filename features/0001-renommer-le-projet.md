---
id: 0001
title: Renommer le projet (plus lié à Cursor — c'est un proxy Claude)
type: chore
priority: P2
version:
epic:
status: todo
ready:
pr:
created: 2026-08-01
---

## Contexte / Problème

Le dépôt s'appelle `cursor-claude-connector` et l'URL de prod est `elzinko-cursor-claude-connector.vercel.app`, mais le projet **n'est plus centré sur Cursor** : c'est un **proxy exposant une API compatible OpenAI adossée à Claude** (endpoints `/v1/models`, `/v1/chat/completions`, `/v1/messages`, `/v1/responses`), avec un dashboard intitulé « **Claude Proxy** ». Cursor n'est plus qu'un client parmi d'autres. Le nom actuel induit en erreur.

## Proposition

Renommer le projet. Nom proposé (à trancher) :
- **`claude-proxy`** (colle au titre du dashboard), ou
- **`claude-openai-proxy`** (plus descriptif : proxy OpenAI-compatible → Claude).

Impacts à couvrir :
- Dépôt GitHub (renommer ; GitHub pose une redirection auto de l'ancien nom).
- `package.json` `name`.
- Projet Vercel + domaine/URL de prod ; **garder l'ancien domaine en alias** le temps de migrer les clients.
- README, badges, docs (`USER_GUIDE.md`, `CURSOR_SETUP.md`, `VERCEL_DEPLOYMENT.md`), messages console (`logConnectionInfo` mentionne « Cursor configuration »).
- **Clients qui pointent l'URL** (ex. EC2 / agents) → mettre à jour ou garder l'alias.

## Critères d'acceptation

- [ ] Nouveau nom décidé (décision produit).
- [ ] Dépôt GitHub + `package.json` + projet Vercel renommés.
- [ ] Nouvelle URL en place, **ancienne URL redirigée/aliasée** (aucun client cassé).
- [ ] README / docs / messages console à jour (« Cursor » n'est plus l'identité principale ; reste listé comme client supporté).

## Notes

Le support Cursor (bypass BYOK, `src/utils/cursor-byok-bypass.ts`) **reste** — seul le NOM/l'identité du projet doit cesser d'être cursor-centrique. Décision de nom = utilisateur.
