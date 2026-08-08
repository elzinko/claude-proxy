# PLAN — claude-proxy

> Séquence de build décidée (PO). Le gate `ready:` reste la porte technique de
> tirage ; ce plan dit **l'ordre**. **Rafraîchi le 2026-08-07** après la session
> sécu + passkeys. Décisions actées : élicitation signée = **durcissement V2**
> (non bloquant) · surface B (0007) **différée** (arbitrage A).

## ✅ Livré (rappel — détail dans `done/` + [BACKLOG.md](BACKLOG.md))

Sécu **0008** complète (TL1-8) · **0004** révocation (key-id + globale + runbook) ·
**0002** 401 explicite · **0006 V1** registre de clés par appli + plan admin ·
**0009** passkeys / WebAuthn admin (Phases 1-3) · rename **claude-proxy** ·
README + vignettes · deps (vitest 4 ; **TS 7 écarté** — casse le build Vercel).
`ADMIN_SECRET` posé dans l'env Vercel.

## NOW

- *(Rien de bloquant.)* Le cœur sécurité et le control plane admin **V1** sont
  livrés et déployés.

## NEXT — optionnel, à tirer si le besoin se confirme

- **0006 V2** — élicitation **signée** du control plane MCP (le secret « cher » :
  broker signé hors canal LLM, façon `google-mcp-multi-account`). La **biométrie
  admin est déjà couverte par 0009** ; il ne resterait que la signature hors-canal.
  **Débattu** (jugé sur-dimensionné pour un proxy mono-utilisateur) → rouvrir
  seulement si un vrai besoin émerge.
- **0003** — swap auth `claude setup-token` + SDK. **Optionnel** : l'OAuth +
  auto-refresh actuel marche et est verrouillé depuis #17.

## PARKÉ

- **0007** — brique SDK (surface B) : **différée** (décision A). Rouvrir après
  résolution du marker « You are Claude Code » + risque CGU.

## Épic ouvert

- **0005** — gestion des tokens via MCP à élicitation forte : épic parent ; ses
  enfants 0002/0004/0006-V1 sont livrés, le reliquat = l'élicitation signée V2
  (cf. NEXT).

> 📝 Article de blog « fail-closed vs fail-open » : brouillon en **PR #40 (draft)**,
> attend relecture avant publication.
