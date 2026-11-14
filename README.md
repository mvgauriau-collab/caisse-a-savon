# La Grande Descente, version Vercel

Course de caisses à savon multijoueur. Cette version se déploie sur Vercel : les joueurs ouvrent un lien, sans serveur à lancer.

## Ce qu'il y a dans le dossier

- `public/` : le jeu (page principale, écran partagé, moteur 3D embarqué). Servi tel quel.
- `api/ws.js` : la fonction Vercel qui tient les connexions WebSocket (`/api/ws`).
- `api/account.js` : la fonction Vercel des comptes pilotes (`/api/account`).
- `lib/game.js` : les règles des parties (salons, départ, arrivées, classement).
- `lib/accounts.js` : comptes, sessions et statistiques.
- `lib/store.js` : l'état partagé entre instances, dans Redis.
- `dev-server.js` : pour jouer en local sans Vercel.
- `test/` : vérifie que deux instances se coordonnent bien.

## Mise en ligne

1. Mets ce dossier dans un dépôt GitHub (privé ou public).
2. Sur vercel.com, crée un projet à partir de ce dépôt. Aucun réglage de build à changer.
3. Ajoute une base Redis au projet depuis le Marketplace Vercel (rubrique stockage du projet). Upstash propose une offre gratuite. Le jeu lit `REDIS_URL` (ou `KV_URL`), et à défaut reconstruit l'adresse à partir des variables Upstash `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN` (ou `KV_REST_API_URL` et `KV_REST_API_TOKEN`).
4. Redéploie pour que la fonction voie la variable.
5. Ouvre l'adresse du projet : c'est prêt.

Les WebSockets demandent « Fluid compute », activé par défaut sur les projets récents.

## Pourquoi Redis

Vercel peut répartir les joueurs d'une même partie sur plusieurs instances de la fonction. Sans stockage commun, ils ne se verraient pas. Redis porte donc l'état de chaque partie et relaie les messages d'une instance à l'autre.

Quand tous les joueurs d'une partie sont sur la même instance, ce qui est le cas le plus courant, les positions ne passent pas par Redis : seuls les changements d'état (arrivée d'un joueur, départ, arrivées, classement) y sont écrits.

Sans `REDIS_URL`, le jeu démarre quand même avec un état en mémoire, mais ce n'est fiable qu'en local.

## Coupure des connexions

Vercel ferme une connexion quand la fonction atteint sa durée maximale (300 secondes ici, réglable dans `vercel.json` selon l'offre). Le jeu se reconnecte tout seul et le joueur garde sa place, sa caisse et sa course en cours. Un joueur qui ne revient pas au bout de 20 secondes est retiré de la partie.

## Comptes pilotes

- Facultatifs : on peut jouer sans compte, le niveau reste alors dans le navigateur.
- Un compte, c'est un pseudo et un code secret. Le code n'est jamais stocké, seulement son empreinte.
- Le serveur enregistre chaque course terminée : expérience, nombre de courses, victoires, podiums et les 10 dernières courses.
- Victoire et podium ne comptent qu'à partir de 2 pilotes, et le dernier n'est jamais sur le podium.
- Le pays choisi à la création (modifiable ensuite) affiche le drapeau du pilote sur la grille, dans le classement en direct et sur son fanion.
- Pas de récupération automatique d'un code oublié. Les comptes sont dans Redis (clés `gd:acct:*`).

## Bots

- L'hôte peut ajouter de 0 à 3 bots sur la grille ; ils prennent les places libres.
- Ils sont pilotés par le navigateur de l'hôte, qui diffuse leurs positions aux autres joueurs.
- Une course avec des bots est classée normalement, mais n'est créditée sur aucun compte : ni expérience, ni course, ni podium.

## Circuits

Trois ambiances, au choix de l'hôte sur la grille (ou au hasard) : Campagne, Désert, Hiver. Le tracé est tiré à chaque manche ; l'hiver adhère un peu moins.

## Parties

- Chaque partie est une salle avec un nom libre (2 à 16 lettres, chiffres ou tirets). On tape un nom : la salle est créée si elle n'existe pas, sinon on la rejoint. Champ vide : salle privée au nom tiré au hasard. Le nom n'est gardé nulle part côté navigateur.
- Un nom de salle n'est pas un mot de passe : quiconque le devine peut entrer s'il reste une place.
- Le bouton Inviter de la grille partage un lien qui pré-remplit le nom de la salle.
- Depuis la course : menu (ou Échap) pour abandonner et revenir à la grille, ou quitter la salle. Depuis la grille et les résultats : quitter la salle.
- Le salon `JGA` a son circuit : Bournezeau (Vendée), choisi d'office et proposé seulement dans ce salon (et en LAN). Tracé fixe relevé à l'œil sur une vue satellite du bourg, du nord au sud : rue principale, place de la Mairie, le S du centre, carrefour de la rue Jean Grolleau, cimetière, puis rue de l'Armistice (D48) jusqu'au rond-point. Longueurs doublées pour que la course dure, bâtiments stylisés, enseignes génériques. Données dans `BZ_PLAN` (`public/index.html`). Pour réserver un autre circuit à un salon : table `SPECIAL` dans `lib/game.js`.
- Classement général des comptes (niveau, victoires, podiums), accessible depuis l'atelier et la grille (`gd:lb:*` dans Redis).
- 8 pilotes maximum par salle (humains et bots confondus, départ sur deux lignes), autant de salles en parallèle que voulu. L'écran partagé sur un clavier reste limité à 4.
- L'écran partagé (`/duo?n=2` à `4`) met tous les joueurs du clavier dans la même partie.
- Une partie inactive est effacée au bout de 2 heures.

## En local

```
npm install
npm run dev          # http://localhost:3000
npm test             # deux instances simulées, Redis simulé
COUPURE=20 npm run dev   # coupe chaque connexion après 20 s, pour voir la reconnexion
```
