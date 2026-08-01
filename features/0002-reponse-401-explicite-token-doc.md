---
id: 0002
title: Réponse 401 explicite avec doc de génération de token
type: feature
priority: P2
epic: 0005
status: todo
ready:
pr:
created: 2026-08-01
---

# 0002 — Réponse 401 explicite avec doc de génération de token

## Contexte / Problème

Quand un client (Cursor, mais aussi n'importe quel projet perso pointant vers le
proxy) appelle une route LLM et que le proxy **n'a pas de token Claude valide**
(jamais authentifié, ou token expiré), la réponse doit être **explicite et
actionnable** — pas un 401 opaque. Le client (humain ou LLM) doit comprendre
*quoi faire* directement depuis la réponse.

## Proposition

Retourner un 401 structuré dont le corps porte la marche à suivre pour générer
un token **en local** et le fournir au proxy. Forme visée :

```json
{
  "error": {
    "type": "proxy_not_authenticated",
    "message": "Le proxy n'a pas de token Claude valide.",
    "hint": "Génère un token d'abonnement en local puis fournis-le au proxy.",
    "docs": {
      "generate": "claude setup-token   # login navigateur, imprime un sk-ant-oat…",
      "provide": "définis ANTHROPIC_AUTH_TOKEN dans l'env Vercel, puis redeploy",
      "url": "https://github.com/elzinko/claude-proxy#authentification"
    }
  }
}
```

Couvrir les deux cas : **pas de token** et **token expiré** (voir [[0003-swap-auth-setup-token-sdk]]).

## Critères d'acceptation

- [ ] Requête sans token → 401 avec `type`, `hint`, `docs` renseignés
- [ ] Requête avec token expiré → 401 distinct (message "expiré") + même doc
- [ ] Le corps est valide pour un client OpenAI-compat (ne casse pas le parsing)
- [ ] La doc pointée existe (section README) et est juste

## Notes / décisions

- Issu de la discussion archi/sécu du 2026-08-01.
- Se marie avec [[0003-swap-auth-setup-token-sdk]] (si on passe à setup-token, le
  message de génération devient la voie principale de re-authentification).
