# ADR-0001 : Noyau "auth abonnement + élicitation", séparé de ses surfaces de livraison

**Status:** Proposed *(en review adverse — ne pas accepter avant intégration des findings)*
**Date:** 2026-08-01
**Deciders:** elzinko (PO)
**Épic:** [0005](../../features/0005-gestion-tokens-mcp-elicitation.md) · **Fiches:** 0002, 0003, 0004, 0006, 0007

## Context

claude-proxy fait passer un **abonnement Claude Pro/Max** vers des clients qui ne
sont pas Anthropic-natifs (Cursor, OpenAI-compat). Deux forces nouvelles :

1. **Multi-consommateurs & révocation.** On veut une **clé par appli** (générée en
   qq secondes, procédure affichée), **auto-refresh**, et une **révocation rapide
   par appli OU globale** — sans casser les autres projets.
2. **Réutilisation par les projets SDK.** Plusieurs projets perso appellent déjà
   Claude **via le SDK officiel** (ex. samplerz : `ANTHROPIC_AUTH_TOKEN` + SDK
   `anthropic`). L'utilisateur veut qu'un nouveau projet réutilise une **brique
   déjà développée** pour l'auth abonnement (+ éventuellement l'élicitation) au
   lieu de la réimplémenter.

Contraintes (dures) :

- **Le LLM n'a JAMAIS la main** sur une action privilégiée (mint/revoke/add) :
  élicitation « **propose-command, never execute** » + confirmation **signée hors
  du canal LLM** (inspiré de `google-mcp-multi-account`, `gateway/elicitation.py`,
  `ADR-0005`). **Déterministe / fail-closed.**
- **Vercel serverless** = FS éphémère, **pas de biométrie côté serveur** → le
  *control plane* (mint/revoke + signature) doit vivre **en local**.
- **Mono-utilisateur** assumé (zone grise CGU des abonnements) + disclaimer.
- Repo **public**.

## Decision

Structurer le système en **un NOYAU indépendant de la livraison** + **des SURFACES
de livraison** au-dessus, avec un **control plane local** pour tout ce qui est
privilégié.

**NOYAU (delivery-agnostic)** — côté serveur (proxy) sauf mention :
- **Auth amont** : cycle de vie du token d'abonnement (acquisition, **auto-refresh**
  via `refresh_token` grant côté serveur), **un seul** token, jamais exposé aux clients.
- **Registre de clés aval (par appli)** : clés opaques, **stockées hachées** (jamais
  en clair), métadonnées (`label`, `created`, `last_used`, `status`), révocables.
- **Gate d'autorisation par élicitation** : mint/revoke/add ne s'exécutent qu'après
  confirmation **signée** dans un canal hors-LLM. Le serveur applique des **ordres
  signés** ; la **signature + clé privée vivent en local** (control plane).
- **Audit** (receipts) + **default-deny**.

**SURFACES de livraison** (partagent le noyau) :
- **A — Proxy OpenAI-compat** *(existant)* : Cursor & clients OpenAI. Clé par appli.
- **B — Passthrough Anthropic natif** *(nouveau — la « brique SDK »)* : les projets
  qui utilisent le **SDK officiel** pointent `ANTHROPIC_BASE_URL` sur le proxy et
  s'authentifient avec **leur clé par appli** (`ANTHROPIC_AUTH_TOKEN` → `Authorization:
  Bearer`). Le proxy expose `/v1/messages` en **passthrough natif** et forwarde avec
  le token amont côté serveur. **Le token d'abonnement ne quitte jamais le serveur.**

**Control plane LOCAL** : un MCP local (fiche 0006) porte l'élicitation signée
(Touch ID/ECDSA sur Mac, **mock HMAC** ailleurs) et pilote une **API admin** du proxy
(secret admin ≠ clés clients) pour mint/list/revoke.

### Tranchage des questions de grooming (0005)

- **Clés aval** : opaques aléatoires, **stockées hachées** (SHA-256) dans Redis
  Upstash existant ; réconcilie le `sha256(api_key+ip)` du dashboard actuel.
- **Auto-refresh amont** : **côté serveur**, on garde un `refresh_token` grant maison
  (l'utilisateur veut l'auto-refresh ; setup-token-en-env pur ne rafraîchit pas en
  serverless — cf. 0003).
- **Global revoke** : *aval* = purge/disable de toutes les clés (déterministe,
  serveur). *Amont* = **runbook** (révoquer l'app chez Anthropic) — **pas** garanti
  automatisable, documenté honnêtement. Un reset local seul ne tue pas un token amont **copié**.
- **MCP** : à trancher au build (SDK MCP officiel vs skeleton stdio) — n'engage pas l'archi.
- **Élicitation** : réutiliser `gateway/elicitation.py` (Touch ID + mock) ; V1
  possible sur le seul secret admin + mock, biométrie en durcissement.

## Options Considered

### Option A : Monolithe proxy-only (statu quo étendu)

Clés par appli **dans le proxy**, pas de noyau partagé ; les projets SDK continuent
chacun avec **leur propre token amont** (samplerz-style).

| Dimension | Assessment |
|-----------|------------|
| Complexité | Low |
| Coût | Low (rien de neuf pour le SDK) |
| Sécurité (blast radius) | **Mauvais** — chaque projet détient le token amont ; révocation = tout ou rien |
| Réutilisation | **Nulle** — chaque projet SDK réimplémente auth (+ élicitation) |
| Maintenance | Duplication N projets |

**Pros:** rien à construire pour la voie SDK.
**Cons:** ne répond PAS à la demande « brique réutilisable » ; token amont dupliqué partout ; pas de révocation par appli côté SDK.

### Option B : Noyau + surfaces (proxy OpenAI-compat + passthrough SDK) — **recommandée**

| Dimension | Assessment |
|-----------|------------|
| Complexité | Medium (extraire le noyau + 1 endpoint passthrough) |
| Coût | Medium — le passthrough natif est quasi un forward |
| Sécurité (blast radius) | **Bon** — token amont **jamais** chez les clients ; **révocation par appli** |
| Réutilisation | **Forte** — brique SDK = 2 variables d'env, tout langage |
| Maintenance | Un noyau, deux surfaces minces |

**Pros:** répond aux deux forces ; cross-langage *gratuit* (base_url est standard SDK) ; révocation granulaire ; élicitation centralisée.
**Cons:** un endpoint natif à ajouter + maintenir ; tout le trafic SDK repasse par le proxy (latence/point de défaillance).

### Option C : Bibliothèques partagées par langage (packages Python + TS)

Chaque projet **embarque** un package (`elzinko-claude-subscription`) encapsulant
auth+refresh+élicitation devant le SDK officiel.

| Dimension | Assessment |
|-----------|------------|
| Complexité | High (2 packages à écrire/publier/versionner) |
| Réutilisation | Bonne mais **coûteuse** (2× maintenance) |
| Sécurité | Le package détient quand même un token amont en process (blast radius) |

**Pros:** appels Claude en direct (pas de hop proxy).
**Cons:** 2× maintenance ; ne règle pas le blast radius du token amont ; l'approche base_url (B) donne le cross-langage **sans** package.

## Trade-off Analysis

Le pivot est **où vit le token amont**. En **B**, il reste **exclusivement côté
serveur** ; les projets ne détiennent que des **clés aval révocables par appli** —
c'est *le* gain sécurité, et c'est aussi ce qui rend la révocation granulaire
possible. **C** garde le hop en moins mais réintroduit le token amont dans chaque
process (le problème même qu'on veut éliminer). **A** ne répond pas à la demande.

Le coût de **B** (un endpoint passthrough + faire transiter le SDK par le proxy) est
réel mais faible : le passthrough Anthropic natif est plus simple que la conversion
OpenAI déjà en place, et « SDK officiel + `base_url` » est une capacité **native** du
SDK — la brique est donc essentiellement *de la doc + un endpoint*, pas un package.

**Recommandation : Option B.** C garde sa place comme *durcissement futur optionnel*
(un mince helper par langage qui récupère la clé par appli via le MCP local à la
première exécution) — mais n'est pas requis pour livrer la brique.

## Consequences

- **Plus facile** : ajouter un projet (2 env vars) ; révoquer un projet sans toucher
  aux autres ; centraliser l'élicitation ; garder le token amont hors des clients.
- **Plus dur** : le proxy devient un **point de passage critique** pour le trafic SDK
  (dispo/latence/observabilité à soigner) ; il faut maintenir **deux** surfaces
  (OpenAI-compat + natif) cohérentes (cache, betas, streaming).
- **À revisiter** : la révocation **amont** reste un runbook manuel tant qu'Anthropic
  n'expose pas de révocation programmatique — surveiller. La frontière « le LLM ne
  peut pas contourner » n'est vraie qu'au niveau **coopératif** (un shell libre
  contourne la passerelle) — le vault + le secret hors-canal sont l'atténuation, à
  documenter sans survendre.

## Action Items

1. [ ] Passer cet ADR en **review adverse** (bypass, révocation incomplète, ToS, dispo) avant `Accepted`.
2. [ ] Créer la fiche **0007** — Brique SDK (passthrough natif + `base_url` + clé par appli).
3. [ ] Refléter le tranchage des 6 questions dans l'épic 0005 et poser les `ready:`.
4. [ ] Décision de build (MCP SDK vs skeleton ; élicitation V1 mock vs Touch ID) — au grooming des enfants.
