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
| [0006](0006-mcp-controle-tokens.md) | MCP local — mint/list/revoke des tokens par appli + élicitation signée | feature | P1 | 🟠 in-progress | 0005 | [#20](https://github.com/elzinko/claude-proxy/pull/20) (V1) |
| [0003](0003-swap-auth-setup-token-sdk.md) | Swap auth vers `claude setup-token` + SDK (+ auto-refresh) | refactor | P2 | 🔴 todo | 0005 | — |

> **0006** : registre de clés par appli **V1 livré** (#20) ; reste la V2 « élicitation
> signée / control plane MCP ». **0003** : optionnel (l'OAuth actuel marche, verrouillé
> depuis #17).

## 💡 Idées (non groomées / parkées)

| # | Titre | Type | Prio | Statut |
|---|-------|------|------|--------|
| [0007](0007-brique-sdk-passthrough-natif.md) | Brique SDK — passthrough natif (**différée**, arbitrage A) | feature | P1 | 💡 idea |
| [0001](0001-noms-alternatifs-branding.md) | Noms alternatifs "hermez" / "iriz" (parking branding) | chore | P3 | 💡 idea |

## ✅ Livrées (`done/`)

| # | Titre | Prio | PR |
|---|-------|------|----|
| [0009](done/0009-passkeys-webauthn-admin.md) | Passkeys / WebAuthn pour le tier admin (Phases 1-3) | P1 | #38, #39, #41 |
| [0008](done/0008-durcissement-securite-trous-live.md) | Durcissement sécurité — trous LIVE confirmés (TL1-8) | **P0** | #17, #32, #33, #34, #35, #36 |
| [0004](done/0004-kill-switch-gardien.md) | Kill-switch / gardien — révocation (key-id / global / amont) + runbook | P1 | #31 |
| [0002](done/0002-reponse-401-explicite-token-doc.md) | Réponse 401 explicite avec doc de génération de token | P2 | #21 |
