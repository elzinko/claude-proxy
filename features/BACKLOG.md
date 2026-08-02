# Backlog — claude-proxy

> Index du backlog. Le script `regen` d'ezk-backlog vit dans le monorepo
> mega-city (absent de ce repo standalone) : cet index est donc **tenu à la
> main** en épousant le format ezk-backlog. Guide : [README.md](README.md).
>
> Archi : [ADR-0001](../docs/adr/ADR-0001-noyau-auth-elicitation-surfaces-livraison.md) (**Accepted**) · Ordre de build : [PLAN.md](PLAN.md).
> Statuts : 💡 idea · 🔴 todo · 🟠 in-progress · ⛔ blocked · ✅ shipped · 🎯 = `ready` (tirable)

## 🧭 Épics (non tirables — voir enfants)

| # | Titre | Prio | Statut |
|---|-------|------|--------|
| [0005](0005-gestion-tokens-mcp-elicitation.md) | Gestion des tokens via MCP à élicitation forte | P1 | 🔴 todo |

## Fiches actionnables

| # | Titre | Type | Prio | Statut | Épic | PR |
|---|-------|------|------|--------|------|----|
| [0008](0008-durcissement-securite-trous-live.md) | Durcissement sécurité — trous LIVE (repo public déployé) | bug | **P0** | 🟠 in-progress | — | [#17](https://github.com/elzinko/claude-proxy/pull/17) (TL1-4) |
| [0006](0006-mcp-controle-tokens.md) | MCP local — mint/list/revoke des tokens par appli + élicitation signée | feature | P1 | 🔴 todo 🎯 | 0005 | — |
| [0004](0004-kill-switch-gardien.md) | Kill-switch / gardien — révocation (key-id / global / amont) + fix `/auth/*` | feature | P1 | 🔴 todo | 0005 | — |
| [0002](0002-reponse-401-explicite-token-doc.md) | Réponse 401 explicite avec doc de génération de token | feature | P2 | 🔴 todo 🎯 | 0005 | — |
| [0003](0003-swap-auth-setup-token-sdk.md) | Swap auth vers `claude setup-token` + SDK (+ auto-refresh) | refactor | P2 | 🔴 todo | 0005 | — |

**🎯 Prêtes à tirer** : **0006**, **0002**. Ordre (PLAN) après merges : 0006 → 0004 → 0002.
**Bloquée par dépendance** : 0004 (attend le registre key-id de 0006).

## 💡 Idées (non groomées / parkées)

| # | Titre | Type | Prio | Statut |
|---|-------|------|------|--------|
| [0007](0007-brique-sdk-passthrough-natif.md) | Brique SDK — passthrough natif (**différée**, arbitrage A) | feature | P1 | 💡 idea |
| [0001](0001-noms-alternatifs-branding.md) | Noms alternatifs "hermez" / "iriz" (parking branding) | chore | P3 | 💡 idea |

> Livrées (`done/`) : —
