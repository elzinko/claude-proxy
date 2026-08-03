# PLAN — claude-proxy

> Séquence de build décidée (PO), 2026-08-03. Le gate `ready:` reste la porte
> technique de tirage ; ce plan dit **l'ordre**. Décisions actées :
> **élicitation signée dès la V1** · **surface B différée** (arbitrage A).

## NOW

1. **Merger les PRs ouvertes** — #17 (sécu urgente), #18 (rename), #16 (backlog + ADR) ; poser **`ADMIN_SECRET`** dans l'env Vercel.
2. **0006** 🎯 — cœur V1 : registre de **clés par appli** (key-id, haché) + **plan admin** (secret admin) + **MCP local à élicitation signée**. Intègre MF1/MF5/MF6/MF7.
3. **0004** — révocation **par key-id** / globale + runbook amont + **fix TL5** (mutations `/api/*` hors tier client). *Dépend de 0006.*
4. **0002** 🎯 — réponse **401 explicite** avec procédure d'intégration affichée. *Indépendant.*

## NEXT

- **0008** — finir **TL6–TL8** (rate-limiter Redis, IPINFO, allowlist headers) + `/auth/status`.
- **README** — réécriture complète + vignettes (CI, coverage, Dependabot, CodeQL, OpenSSF, buymeacoffee). *(demande initiale, encore due)*
- **0003** — swap auth `setup-token` (optionnel : l'OAuth + refresh actuel marche et est verrouillé depuis #17).

## PARKÉ

- **0007** — brique SDK (surface B) : **différée** (décision A). Rouvrir après résolution du marker « You are Claude Code » + risque CGU.

> 🎯 = `ready:` posé (tirable). Ordre de tirage après merges : **0006 → 0004 → 0002**.
