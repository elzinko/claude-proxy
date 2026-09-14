<!-- STATUS: DRAFT / non relu -->
> **🚧 Brouillon — pas encore relu par l'auteur.** Cet article a passé le panel de
> relecture `ezk-article` (verdict interne « publier »), mais **je ne l'ai pas
> encore validé moi-même**. À relire et approuver avant toute publication.

# Le jour où Redis a hoqueté, et mes deux gardes ont réagi en sens inverse

> **La règle en une phrase.** La direction dans laquelle ton code échoue n'est pas
> un détail : elle dépend de ce qu'il protège — le **droit d'entrer**, ou le fait
> de **rester debout**. Et le bon réflexe est parfois l'exact opposé d'un cas à
> l'autre.

## D'abord, le produit (sinon l'histoire n'a pas de sens)

J'ai bricolé un petit serveur, **claude-proxy**. Il se place entre mes projets
perso — mon éditeur Cursor, mes petits scripts — et [Claude](https://claude.ai/)
(l'assistant IA d'Anthropic) pour qu'ils utilisent **mon** abonnement sans que je
recopie mes identifiants partout. Bref, un intermédiaire — un **portier**. *(Il tourne sur [Vercel](https://vercel.com/) et
range ses infos dans [Redis](https://redis.io/), une petite mémoire ultra-rapide
hébergée chez [Upstash](https://upstash.com/).)*

Ce portier a **deux gardes** à l'entrée, et c'est toute l'histoire :

- **Le contrôleur d'accès** — il vérifie que **ta clé** (l'identifiant que chaque
  projet présente au portier) n'a pas été **révoquée** (coupée parce qu'elle a
  fuité). Il décide **qui entre**.
- **Le compteur** (le *rate-limiter*) — il plafonne le nombre de requêtes par appli,
  pour qu'un projet emballé ne fasse pas exploser mon quota. Il décide **combien de
  fois**.

Retiens juste ça : un garde protège un **accès** (qui a le droit d'entrer),
l'autre protège une **disponibilité** (que le service reste debout et joignable).
On y revient — c'est le cœur de l'histoire.

## Le mardi soir où tout a hoqueté

Un ralentissement — un « pic de latence » — chez mon hébergeur, et pendant quelques
secondes mes deux gardes n'arrivent plus à joindre Redis, leur mémoire commune. Ni l'un ni l'autre ne peut
faire son travail normalement.

Et là, surprise : **ils réagissent à l'opposé**. Le contrôleur d'accès **bloque
tout**. Le compteur **laisse tout passer**. Le même incident, deux réflexes
inverses — et, tu vas voir, **les deux ont raison**.

## Garde n°1 : dans le doute, il claque la porte

Le contrôleur d'accès n'arrive plus à vérifier si une clé est révoquée. Que
fait-il ? Il **refuse**.

Le raisonnement est tout simple : s'il est **incapable de garantir** qu'une clé
n'est pas révoquée, la laisser entrer reviendrait peut-être à rouvrir la porte à
une clé volée — pile pendant la panne. Alors il se ferme. On appelle ça
**fail-closed** : *quand le mécanisme lui-même casse, il se met en position
fermée.* La panne coûte un peu de service, mais elle ne **troue** jamais la
sécurité.

> 🔎 **Dans le code** — [`isRevoked`](https://github.com/elzinko/claude-proxy/blob/main/src/middleware/client-tracker.ts)
> répond « révoqué » (donc : refusé) dès qu'elle n'arrive pas à interroger Redis.

## Garde n°2 : dans le doute, il laisse passer

Le compteur, lui, n'arrive plus à ajouter +1 à son total. Même situation, mais il
fait **l'inverse** : il **autorise**.

Pourquoi ? Parce qu'il ne protège pas la sécurité — il protège la
**disponibilité**. S'il refusait tout le trafic juste parce qu'un compteur est en
panne, il ferait tomber le service qu'il est censé garder debout : un
**auto-sabotage**, une panne que je m'inflige tout seul, sans même un attaquant. On
appelle ça **fail-open** : *quand le mécanisme casse, il se met en position
ouverte.*

*(Oui, pendant ces quelques secondes, un projet emballé pourrait dépasser son
quota. Mais la panne dure des secondes quand le quota, lui, se compte sur une
heure : quelques requêtes non comptées, ce n'est rien. Bloquer tout le monde, si.)*

> 🔎 **Dans le code** — [`rate-limiter.ts`](https://github.com/elzinko/claude-proxy/blob/main/src/middleware/rate-limiter.ts) :
> sur une erreur Redis, `check()` renvoie « autorisé ».

## La règle à retenir

Le même incident — « Redis ne répond plus » — et pourtant **deux bonnes réponses
opposées**. Ce qui change, ce n'est pas la technique : c'est **ce que chaque garde
protège**.

| Le garde protège… | En panne, il doit… | Sinon… |
|---|---|---|
| un **accès** (auth, révocation) | se **fermer** (*fail-closed*) | laisser entrer troue la sécurité |
| une **disponibilité** (quota, débit) | s'**ouvrir** (*fail-open*) | tout refuser fait tomber le service |

Le piège, c'est le dogme rassurant « *fermer par défaut, c'est toujours plus
sûr* ». Sur une porte d'entrée, oui. Sur un garde-fou de disponibilité, c'est **te
tirer une balle dans le pied** : tu transformes le moindre hoquet de ta base en
panne générale de ton produit.

## De retour au mardi soir

Redis est revenu au bout de quelques secondes. Personne n'a rien vu — non pas parce
que mes deux gardes ont fait la même chose, mais parce que **chacun a échoué du bon
côté** : l'un fermé, l'autre ouvert.

*(En toute honnêteté : ce soir-là, comme mes deux gardes dépendent du même Redis,
c'est surtout le contrôleur d'accès qui s'est fait entendre — il refusait déjà
tout. Le compteur « fail-open » rend surtout service le jour où une **seule** des
deux choses casse. Mais la règle, elle, ne bouge pas.)*

Alors la prochaine fois que tu écris un `catch` autour d'un truc qui peut casser,
pose-toi la vraie question, toute bête : *est-ce que ce bout de code protège un
**accès**, ou une **disponibilité** ?* La réponse te dit de quel côté tomber. Et
elle t'évite, un mardi soir, de te faire tomber toi-même.

---

*Pour creuser : ce réflexe est un cousin du
[théorème CAP](https://fr.wikipedia.org/wiki/Th%C3%A9or%C3%A8me_CAP) (Cohérence,
Disponibilité, tolérance au Partitionnement — en cas de coupure réseau, un système
distribué doit choisir entre cohérence et disponibilité) : comme CAP arbitre pour
le système entier, ici chaque garde arbitre **accès vs disponibilité**, garde par
garde. Le code est public : [github.com/elzinko/claude-proxy](https://github.com/elzinko/claude-proxy).*
