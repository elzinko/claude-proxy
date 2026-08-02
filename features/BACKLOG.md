# Backlog — claude-proxy

> Index du backlog. Le script `regen` d'ezk-backlog vit dans le monorepo
> mega-city (absent de ce repo standalone) : cet index est donc **tenu à la
> main** en épousant le format ezk-backlog. Guide : [README.md](README.md).
>
> Décision d'archi : [ADR-0001](../docs/adr/ADR-0001-noyau-auth-elicitation-surfaces-livraison.md) (noyau + surfaces ; **amendé après review adverse — 2 arbitrages PO ouverts**).
> Statuts : 💡 idea · 🔴 todo · 🟠 in-progress · ⛔ blocked · ✅ shipped

## 🧭 Épics (non tirables — voir enfants)

| # | Titre | Prio | Statut |
|---|-------|------|--------|
| [0005](0005-gestion-tokens-mcp-elicitation.md) | Gestion des tokens via MCP à élicitation forte | P1 | 🔴 todo |

## Fiches actionnables

| # | Titre | Type | Prio | Statut | Épic | PR |
|---|-------|------|------|--------|------|----|
| [0008](0008-durcissement-securite-trous-live.md) | **Durcissement sécurité — trous LIVE (repo public déployé)** | bug | **P0** | 🟠 in-progress | — | [#17](https://github.com/elzinko/cursor-claude-connector/pull/17) (TL1-4) |
| [0004](0004-kill-switch-gardien.md) | Kill-switch / gardien — révocation (par appli / global / amont) + fix `/auth/*` | feature | P1 | 🔴 todo | 0005 | — |
| [0006](0006-mcp-controle-tokens.md) | MCP local — mint/list/revoke des tokens par appli + élicitation signée | feature | P1 | 🔴 todo | 0005 | — |
| [0007](0007-brique-sdk-passthrough-natif.md) | Brique SDK — passthrough Anthropic natif (⚠️ arbitrage PO : différer/scoper) | feature | P1 | 🔴 todo | 0005 | — |
| [0002](0002-reponse-401-explicite-token-doc.md) | Réponse 401 explicite avec doc de génération de token | feature | P2 | 🔴 todo | 0005 | — |
| [0003](0003-swap-auth-setup-token-sdk.md) | Swap auth vers `claude setup-token` + SDK (+ auto-refresh) | refactor | P2 | 🔴 todo | 0005 | — |

## 💡 Idées (non groomées)

| # | Titre | Type | Prio | Statut |
|---|-------|------|------|--------|
| [0001](0001-noms-alternatifs-branding.md) | Noms alternatifs "hermez" / "iriz" (parking branding) | chore | P3 | 💡 idea |

> Livrées (`done/`) : —
