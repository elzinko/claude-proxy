<!-- STATUS: DRAFT / non relu -->
> **🚧 Brouillon — pas encore relu par l'auteur.** Cet article a passé le panel de
> relecture `ezk-article` (verdict interne « publier »), mais **je ne l'ai pas
> encore validé moi-même**. À relire et approuver avant toute publication.

# Le jour où Redis a hoqueté, et mes deux gardes ont réagi en sens inverse

> La direction dans laquelle ton code échoue n'est pas un détail d'implémentation :
> elle dépend de ce que tu protèges — un **accès** ou une **disponibilité**. Et le
> bon réflexe est parfois exactement l'opposé de l'autre.

Un mardi soir, mon cache [Redis](https://redis.io/) a eu un hoquet. Rien de
grave — un pic de latence chez mon hébergeur, quelques secondes où les requêtes
vers la base ont expiré (*timeout*). Le genre d'incident qu'on ne remarque même
pas.

Sauf que dans mon petit serveur, **deux gardes se sont réveillés au même instant
et ont fait le contraire l'un de l'autre**. L'un a tout bloqué. L'autre a tout
laissé passer. Et **les deux avaient raison**.

## Le décor : un proxy et ses deux gardes

J'ai monté un petit proxy : un intermédiaire qui reçoit les requêtes de mes
projets perso et les relaie vers [Claude](https://claude.ai/) (l'assistant IA
d'Anthropic) avec mon abonnement, pour ne pas recopier mes identifiants partout.
Il tourne sur [Vercel](https://vercel.com/) (une plateforme d'hébergement
d'applis web) en *serverless* — des fonctions qui s'allument à la demande — avec
[Hono](https://hono.dev/) (un framework web léger) et [Upstash](https://upstash.com/)
comme Redis. Dans cette base clé-valeur ultra-rapide, je garde — entre autres —
les **deux** choses qui nous intéressent ici.

D'abord, la liste des clés **révoquées** : *révoquer*, c'est couper l'accès d'une
clé compromise, immédiatement. Ensuite, des compteurs de **rate-limiting** : un
plafond de requêtes par appli et par heure (100 chez moi), pour qu'un projet
emballé ne fasse pas exploser mon quota.

Deux gardes, donc. Le premier décide **qui a le droit d'entrer**. Le second
décide **combien de fois**. Quand Redis les lâche tous les deux en même temps,
chacun doit répondre à une question inconfortable : *« je n'arrive pas à
vérifier — je fais quoi ? »*

## Garde n°1 : dans le doute, je claque la porte

Vérifier si une clé est révoquée, ça veut dire interroger Redis avec son
**empreinte** (un hash de la clé, jamais la clé en clair). Si Redis ne répond
pas, je ne peux pas savoir. Voici, en simplifié, ce que fait mon code :

```ts
async function isRevoked(empreinte) {
  try {
    return (await redis.sismember(REVOQUEES, empreinte)) === 1
  } catch (err) {
    // On ne peut pas confirmer que cette clé n'est PAS révoquée → on refuse.
    return true // fail closed : dans le doute, deny
  }
}
```

C'est du **fail-closed** : quand le mécanisme lui-même tombe en panne, il se met
en position *fermée*, il refuse. Le raisonnement tient en une phrase : si je suis
incapable de garantir qu'une clé n'est **pas** révoquée, la laisser passer
reviendrait à rouvrir la porte à une clé peut-être volée, précisément pendant la
panne. Un attaquant qui verrait mon Redis vaciller n'aurait qu'à insister. Ici,
la panne coûte de la disponibilité — mais elle ne **troue** jamais la sécurité.

## Garde n°2 : dans le doute, je laisse passer

Le rate-limiter, lui, incrémente un compteur dans Redis. Même panne, même
question. Et pourtant :

```ts
async function check(identifier) {
  const key = `ratelimit:${identifier}` // le compteur de cette appli
  try {
    const count = await redis.incr(key)
    return { allowed: count <= 100 } // 100 = le plafond horaire
  } catch (err) {
    // Un rate-limiter protège la dispo, pas l'accès → on autorise.
    return { allowed: true } // fail open : dans le doute, allow
  }
}
```

Du **fail-open** : en panne, il se met en position *ouverte*, il laisse passer.
Oui, pendant ces quelques secondes, je perds ma protection de quota — un projet
emballé pourrait passer sous le radar. Mais le hoquet dure des **secondes** quand
la fenêtre de comptage, elle, dure une **heure** : quelques requêtes non comptées
ne coûtent rien. Refuser tout le trafic légitime, si.

Car si j'avais copié le réflexe du premier garde — « dans le doute, refuse » —
j'aurais transformé un hoquet de quelques secondes de ma base en **panne totale
de mon service**. Toutes les requêtes légitimes, refusées, parce qu'un compteur
accessoire n'a pas pu s'incrémenter. Je me serais infligé une attaque par déni de
service tout seul, sans attaquant.

## La règle que je me répète maintenant

Même exception (`catch`), même « Redis ne répond pas », et deux bonnes réponses
**opposées**. La différence ne tient pas à la technique, mais à **ce que le code
protège** :

| Le garde protège… | En panne, il doit… | Pourquoi |
|---|---|---|
| un **accès** (auth, révocation) | **fail-closed** — refuser | laisser passer troue la sécurité |
| une **disponibilité** (rate-limit, quota) | **fail-open** — autoriser | refuser provoque la panne qu'on voulait éviter |

Le piège, c'est le dogme réconfortant « *fail-closed partout, c'est plus sûr* ».
Sur une barrière d'accès, oui. Sur un garde-fou de disponibilité, c'est **te
tirer une balle dans le pied** : tu transformes chaque micro-incident de ta
dépendance en incident majeur de ton produit.

## De retour au mardi soir

Redis est revenu au bout de quelques secondes. Personne n'a rien vu. Pas parce
que mes deux gardes ont fait la même chose — mais parce que **chacun a échoué
dans sa propre bonne direction** : l'un fermé, l'autre ouvert.

Soyons honnêtes une seconde : ce soir-là, comme mes deux gardes partagent le même
Redis, c'est surtout le garde d'**accès** (fail-closed) qui a parlé — il refusait
déjà tout, brièvement. Le fail-open du rate-limiter, lui, montre vraiment sa
valeur le jour où l'incident est *partiel* (le compteur lâche, mais pas l'auth)
ou sous forte charge. Le principe, en revanche, ne bouge pas d'un pouce : chaque
garde doit échouer dans **sa** bonne direction, indépendamment de ce que fait
l'autre.

Alors la prochaine fois que tu écris un `catch` autour d'un appel qui peut
échouer, offre-toi la vraie question, toute bête : *est-ce que ce bout de code
protège un **accès**, ou une **disponibilité** ?* La réponse te dit dans quel sens
tomber. Et elle t'évite, un mardi soir, de te faire tomber toi-même.

---

*Pour creuser : ce réflexe est un cousin du
[théorème CAP](https://fr.wikipedia.org/wiki/Th%C3%A9or%C3%A8me_CAP) (Cohérence,
Disponibilité, tolérance au Partitionnement — en cas de coupure réseau, un système
distribué doit choisir entre cohérence et disponibilité). La parenté : comme CAP
arbitre cohérence vs disponibilité pour le système entier, ici chaque garde
arbitre accès vs disponibilité — mais **garde par garde**, pas pour tout le
système d'un coup.*
