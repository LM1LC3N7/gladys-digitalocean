# DigitalOcean

Cette intégration lit votre compte DigitalOcean par son API officielle v2 : vos droplets (état, IPv4
publique), la consommation et le solde du mois, le nombre de règles d'alerte actives et l'état de vos
surveillances (uptime checks). Elle permet d'allumer un droplet ; l'extinction, l'extinction forcée et le
redémarrage sont désactivés tant que vous ne les autorisez pas. Elle ne crée, ne redimensionne et ne supprime
jamais rien.

Intégration non officielle, sans lien avec DigitalOcean. **Jamais testé avec un vrai appareil** : écrite et
testée d'après la documentation officielle de l'API, contre une API simulée, sans compte réel.

## Coûts

L'API de DigitalOcean est gratuite, mais votre compte est facturé selon vos ressources. Cette intégration ne
crée rien et ne change aucune taille : elle ne peut pas augmenter votre facture. Attention : **un droplet éteint
reste facturé** (seule sa suppression arrête la facturation, et l'intégration ne supprime jamais rien).

## Jeton

Dans le panneau de DigitalOcean : **API**, **Tokens**, **Generate New Token**.

- **Lecture seule (recommandé)** : portée **Read**. Tout est lu ; les boutons répondent que le jeton est en
  lecture seule.
- **Pour les boutons** : portée personnalisée (Custom Scopes) avec `droplet:read` et `droplet:update`, plus
  `account:read`, `billing:read`, `monitoring:read` et `uptime:read` pour lire le reste. N'ajoutez ni
  `droplet:create`, ni `droplet:delete`, ni `droplet:admin` : l'intégration n'en a pas besoin.

Le jeton est gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à DigitalOcean
(`api.digitalocean.com`, certificat vérifié). Il n'apparaît dans aucun journal, statut ni fichier de
l'intégration.

Si DigitalOcean refuse le jeton (HTTP 401 sur la liste des droplets : révoqué, expiré, mal saisi), l'intégration
s'arrête et ne le réessaie plus d'elle-même, même après un redémarrage, jusqu'à ce que vous enregistriez un
nouveau jeton ou cliquiez sur **Tester la connexion**. Un refus sur une autre lecture (facture, alertes,
surveillances) n'arrête rien : la lecture concernée est réessayée plus tard, de plus en plus espacée (jusqu'à
1 h), et le statut l'indique.

## Appareils

Depuis la Découverte :

| Appareil            | Fonctions                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Compte DigitalOcean | Consommation du mois, solde du mois, solde du compte (dollars US), règles d'alerte actives, état du compte |
| Un droplet          | Allumé (oui/non), état, IPv4 publique ; boutons Allumer, Éteindre, Forcer l'extinction, Redémarrer         |
| Une surveillance    | En ligne (oui/non), état, disponibilité sur 30 jours (%)                                                   |

- Identifiants : le compte par l'identifiant de son équipe (ou du compte sans équipe), un droplet par son
  numéro, une surveillance par son identifiant DigitalOcean.
- La consommation et le solde sont ceux que DigitalOcean calcule (`generated_at`) ; plus vieux que 48 h, ils ne
  sont pas publiés. Lus une fois par heure.
- Les règles d'alerte de DigitalOcean (CPU, mémoire, disque...) n'exposent pas d'état « déclenché » dans l'API :
  seul leur nombre actif est lu (leurs e-mails et adresses Slack ne sont jamais gardés). L'état « en ligne / hors
  ligne » vient des surveillances (uptime checks) : hors ligne dès qu'une région les voit tomber.
- Une valeur inconnue (vide, illisible, droplet en création) n'est jamais publiée comme 0.
- Les droplets GPU ne sont pas listés (l'API les sépare) ; au-delà de 1000 droplets, les autres sont laissés de
  côté et le statut le dit.

## Boutons

Ce sont des boutons, jamais des interrupteurs : un « tout éteindre » d'un assistant vocal ou d'une scène ne
les atteint pas.

- **Allumer** : permis sans option.
- **Éteindre** (`shutdown`, arrêt propre), **Forcer l'extinction** (`power_off`, comme débrancher la prise),
  **Redémarrer** (`reboot`, propre) : chacun désactivé par défaut, à autoriser dans la configuration.

Pour chaque appui :

1. l'option est relue (une option décochée prend effet immédiatement, même pendant une lecture ou une
   commande en cours) ;
2. le droplet est relu ; la décision se fait sur cette lecture (déjà dans l'état voulu : rien envoyé ;
   verrouillé par DigitalOcean ou état inconnu : refus) ;
3. tout est revérifié juste avant l'envoi (option, pause, quota, arrêt plus récent du même droplet, délai) ;
4. l'envoi part dans les 3,5 s de l'appui ou pas du tout ;
5. une commande n'est dite **faite** que lorsqu'une lecture suivante le montre (Allumer : droplet allumé ;
   Éteindre et Forcer l'extinction : droplet éteint ; Redémarrer : action terminée puis droplet allumé). Les
   relectures suivent à 5 s, 20 s, 60 s (180 s pour Éteindre, 10/30/90 s pour Redémarrer). Sans réponse claire,
   la commande est dite « envoyée, sans confirmation » et n'est jamais renvoyée d'elle-même.

Garde-fous : une commande par droplet toutes les 15 s ; une seule à la fois par droplet ; après Éteindre ou
Forcer l'extinction, Allumer ce droplet est refusé pendant 1 min (garde écrite dans `/data` avant l'envoi ; si
`/data` ne peut pas l'écrire, rien n'est envoyé), y compris après un redémarrage ; un arrêt annule un Allumer du
même droplet pas encore parti. Le résultat de chaque commande s'affiche dans le statut de l'intégration pendant
10 min.

Raisons d'un refus d'Éteindre ou de Forcer l'extinction, rien n'étant envoyé : option désactivée,
intégration non configurée, jeton refusé, pause demandée par DigitalOcean (429 ou 5xx), quota du jeton épuisé,
autre commande en cours ou moins de 15 s depuis la précédente sur ce droplet, droplet introuvable, illisible,
verrouillé ou pas allumé, `/data` qui ne garde pas la garde, jeton changé pendant la commande, DigitalOcean trop
lent (au-delà de 3,5 s). Avec un jeton en lecture, DigitalOcean refuse lui-même (HTTP 403).

## Lectures et quotas

- Les droplets : à chaque rafraîchissement (120 s par défaut, de 60 à 3600 s), jamais plus tôt, même après un
  redémarrage ou un clic sur Scanner ; le compte toutes les 6 h ; la facture et les règles d'alerte toutes les
  heures ; la liste des surveillances toutes les 10 min, et l'état de 10 d'entre elles au plus à chaque
  rafraîchissement, à tour de rôle.
- Le jeton permet 5 000 requêtes par heure (250 par minute), partagées avec vos autres outils. L'intégration
  suit les en-têtes `ratelimit-*` de chaque réponse : sous 20 % restants, elle ne lit plus que les droplets ;
  sous 25 requêtes, elle attend que DigitalOcean en libère (d'après son heure, de 1 min à 1 h).
- Un 429 ou une erreur 5xx met lectures et commandes en pause (durée de `Retry-After`, sinon 1 min, doublée à
  chaque échec répété, 6 h au plus), gardée dans `/data`.
- Aucune redirection n'est suivie ; les réponses sont bornées en taille et en durée.

## Dépannage

- **« DigitalOcean a refusé le jeton »** : créez-en un nouveau, enregistrez-le (ou cliquez sur Tester).
- **« Non lu : facture (billing:read) »** : le jeton n'a pas ce droit ; ajoutez-le ou ignorez.
- **Un bouton répond « jeton sans le droit droplet:update »** : jeton en lecture seule, voulu ou non.
- **« Éteindre : pas encore appliqué »** : l'arrêt propre dépend du système du droplet ; DigitalOcean garantit
  seulement que la demande est transmise. Vérifiez dans le panneau, ou utilisez Forcer l'extinction si vous
  l'avez autorisé.
