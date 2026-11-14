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
- Pas de récupération automatique d'un code oublié. Les comptes sont dans Redis (clés `gd:acct:*`).

## Circuits

Trois ambiances, au choix de l'hôte sur la grille (ou au hasard) : Campagne, Désert, Hiver. Le tracé est tiré à chaque manche ; l'hiver adhère un peu moins.

## Parties

- Chaque partie a un code de 4 lettres. Le premier joueur en crée une en laissant le champ vide, les autres saisissent le code ou ouvrent le lien affiché sur la grille.
- 4 pilotes maximum par partie, autant de parties en parallèle que voulu.
- L'écran partagé (`/duo?n=2` à `4`) met tous les joueurs du clavier dans la même partie.
- Une partie inactive est effacée au bout de 2 heures.

## En local

```
npm install
npm run dev          # http://localhost:3000
npm test             # deux instances simulées, Redis simulé
COUPURE=20 npm run dev   # coupe chaque connexion après 20 s, pour voir la reconnexion
```
