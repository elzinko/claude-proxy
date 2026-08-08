---
id: 0009
title: Passkeys / WebAuthn pour le tier admin (auth forte à empreinte)
type: feature
priority: P1
status: shipped
ready:
pr: "#38,#39,#41"
created: 2026-08-04
---

# 0009 — Passkeys / WebAuthn pour le plan admin

> Ta demande : « saisir mon empreinte pour valider une clé » (auth forte type 2FA
> hardware). Seam prévu par [ADR-0001](../docs/adr/ADR-0001-noyau-auth-elicitation-surfaces-livraison.md)
> (« Vercel serverless = pas de biométrie côté serveur → control plane local »).
> WebAuthn colle exactement : la vérification biométrique est **côté navigateur**,
> le serveur ne vérifie qu'une **signature d'assertion**.

## Problème / valeur

Le plan admin (mint/revoke de clés, setup OAuth, logout) est protégé par un
**secret partagé** `ADMIN_SECRET` (bearer). Un secret partagé fuit (presse-papier,
historique shell, capture). Un **passkey** (Touch ID / clé FIDO2) est **non
phishable et non exportable** : l'action privilégiée exige une présence physique +
biométrie, la clé privée ne quitte jamais l'appareil.

## Décision structurante (à trancher avant l'enforcement)

- **(a) Passkey en 2ᵉ facteur** — `ADMIN_SECRET` reste la base ; un passkey enrôlé
  est requis **en plus** pour les actions admin (ou pour ouvrir une session admin
  courte). Perte du passkey → repli `ADMIN_SECRET`. **Aucun lockout.** ✅ **reco**
- **(b) Passkey remplace `ADMIN_SECRET`** — plus fort (plus de secret partagé),
  mais **risque de lockout** si l'appareil est perdu (recovery délicate sur Vercel).

Le **modèle (a/b) n'affecte QUE l'enforcement** (phase 2). La **cérémonie
d'enrôlement (phase 1) est identique** dans les deux cas → elle se construit sans
attendre l'arbitrage.

## Faisabilité — dé-risquée (2026-08-04)

- `@simplewebauthn/server@13.3.2` **se `require()` proprement en CommonJS** (dual
  package) — pas de mur ESM/CJS comme TS 7 sur Vercel (vérifié : exports
  `generateRegistrationOptions` / `verifyRegistrationResponse` /
  `generateAuthenticationOptions` / `verifyAuthenticationResponse` présents).
- **RP-ID = le domaine** (`elzinko-claude-proxy.vercel.app` ; `localhost`
  en dev). Configurable via `WEBAUTHN_RP_ID` (repli sur le `Host` de la requête).
  ⚠️ si le domaine change, ré-enrôler (les credentials sont liés au RP-ID).
- Stockage **Redis** (mono-utilisateur) : `webauthn:creds` (HASH credentialId →
  credential) + `webauthn:challenge:<id>` (string, TTL court). Fallback mémoire en
  dev, comme key-registry/client-tracker.

## Architecture

```
Navigateur (@simplewebauthn/browser)         Serveur (@simplewebauthn/server, Redis)
  landing: enrôler / s'authentifier   <--->   /auth/webauthn/register/{options,verify}  (ADMIN_SECRET)
  Touch ID / clé FIDO2 (biométrie)            /auth/webauthn/auth/{options,verify}       (public → session)
                                              requireAdmin accepte: ADMIN_SECRET  OU  session passkey (modèle a/b)
```

## Plan de livraison (incrémental)

- **Phase 1 — Fondation d'enrôlement** ✅ **livrée (#38)** : module
  `src/auth/webauthn.ts` (wrappers @simplewebauthn + stockage Redis
  creds/challenges), routes `register/{options,verify}` + `GET`/`DELETE`
  credentials **derrière `ADMIN_SECRET`**. Tests.
- **Phase 2 — Cérémonie d'auth + enforcement** ✅ **livrée — modèle (a)** :
  `/auth/webauthn/auth/{options,verify}` **publics** (credentials découvrables →
  pas d'énumération) ; un passkey vérifié **mint un token de session admin
  HMAC** (`src/auth/admin-session.ts`, signé par `ADMIN_SECRET`, TTL 30 min) ;
  `validateAdmin` accepte `ADMIN_SECRET` **ou** ce token (reste **sync**).
  `ADMIN_SECRET` garde la main (base + secours) → **zéro lockout**.
- **Phase 3 — UI landing** : bloc « Enrôler un passkey » + « Déverrouiller avec
  passkey » via `@simplewebauthn/browser`. *(à faire)*

## Critères d'acceptation (phase 1)

- [ ] `POST /auth/webauthn/register/options` sans `ADMIN_SECRET` → **401**
- [ ] Options de registration contiennent un `challenge` serveur stocké (TTL) + le RP-ID
- [ ] `verify` rejette un challenge inconnu / expiré / une origine ≠ attendue
- [ ] Un credential vérifié est **persisté** (Redis) et **listable** (métadonnées, jamais la clé privée — elle n'existe que sur l'appareil)
- [ ] Fail-closed si `ADMIN_SECRET` non configuré (comme le reste du plan admin)

## Notes / décisions

- 2026-08-04 : dépendance dé-risquée (CJS ok). Reste l'arbitrage **a/b** avant la
  phase 2. Phase 1 constructible immédiatement.
- Un seul utilisateur → pas de multi-compte ; le `userID` WebAuthn est un id owner constant.
