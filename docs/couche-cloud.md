# Construire une couche hébergée sur SuricateWeb

Document de référence pour le dépôt **privé** qui transforme le cœur open source en service multi-comptes (comptes, quotas, paiement, partage). Il décrit ce que le cœur garantit, comment l'assembler, chaque point d'extension, et ce qu'il reste à construire.

État du cœur décrit ici : **version 1.11.0**. Le cœur est sous licence Apache 2.0, sans dépendance npm ; la couche hébergée est un dépôt à part qui l'embarque (sous-module Git ou dépendance Git) et peut, elle, avoir des dépendances (`pg`, un client d'e-mail…).

## 1. Ce que le cœur garantit

| Domaine | Garantie | Où |
|---|---|---|
| Base de données | Tout le SQL est dans `src/db.js`, portable SQLite / PostgreSQL, derrière un adaptateur asynchrone. Les 100 requêtes émises par la suite de tests ont été validées contre PostgreSQL 17 (`PREPARE`) à la version 1.7.0. | `src/store/` |
| Migrations | Numérotées, une version par moteur, suivies dans `schema_migrations`. | `src/store/migrations/` |
| Assemblage | `createApp(options)` : plus aucun démarrage à l'import. | `src/app.js` |
| Comptes | Chaque site et chaque groupe appartient à un compte (`account_id`) ; le cœur n'a que le compte 1. Les routes n'accèdent aux données que par `ctx.data`, qui cloisonne. Une ressource d'un autre compte répond **404**. | `src/scoped.js` |
| Réglages | Deux niveaux : installation et compte. Chaque contrôle, message et relevé utilise ceux du compte propriétaire du site. | `src/db.js` |
| Temps réel | `/api/events` ne transmet à chaque utilisateur que les événements de son compte. | `src/routes/events.js` |
| Droits | Chaque route privée déclare une permission ; `authorize` en décide. | `src/app.js` |
| Réseau | Garde SSRF optionnelle : adresses privées refusées, adresse vérifiée à la connexion (pas de DNS rebinding). | `src/net-guard.js` |
| Notifications | Canaux remplaçables ; Telegram par défaut. | `src/notify.js` |

Ces garanties sont verrouillées par des tests qui **échouent** si on les contourne (voir §8).

## 2. Assembler une application hébergée

Le cœur a son propre point d'entrée (`server.js`) : il lit des identifiants dans le `.env` et ne convient pas à un service multi-comptes. La couche hébergée écrit le sien. **L'ordre compte** : le moteur de base se branche *avant* le premier import de `src/db.js`, que `src/app.js` importe.

```js
// serveur-cloud.js (dépôt privé)
import { configureStore } from '<cœur>/src/store/registry.js';
import { openPostgres } from './postgres.js';              // adaptateur : voir §6
import { migrationsCloud } from './migrations/index.js';  // numéros ≥ 1000

configureStore({
  open: async () => openPostgres(process.env.DATABASE_URL),
  migrations: migrationsCloud,
});

// db.js s'ouvre ici, sur l'adaptateur fourni, et applique les migrations du cœur puis les vôtres.
const { createApp } = await import('<cœur>/src/app.js');
const { createNetGuard } = await import('<cœur>/src/net-guard.js');

const app = createApp({
  env: process.env,
  auth: createCloudAuth(),                 // §3.1
  authorize, entitlements,                 // §3.2, §3.3
  routes: [registerBilling, registerTeam, registerAdmin],
  hooks: { onWatchCreated, onWatchDeleted },
  notifier: cloudNotifier,                 // §3.6
  scheduler: { concurrency: 20, pickDue }, // §3.7
  netGuard: createNetGuard({ allowedPorts: [80, 443, 8080, 8443] }), // §3.8
  capabilities: { mode: 'cloud', billing: true },
  home: createHome(),                      // §3.10
});
await app.listen(Number(process.env.PORT) || 3000, process.env.HOST || '0.0.0.0');
app.startBackground();   // voir l'avertissement ci-dessous
```

Points d'attention :

- `startBackground()` lance le planificateur **et** le lecteur des boutons Telegram du cœur. Définir `TELEGRAM_POLL=0` : ce lecteur est lié au compte implicite 1 et n'a pas de sens en multi-comptes (§3.6).
- **Un seul processus** doit appeler `startBackground()`. Le planificateur choisit les sites « dus » sans les réserver : deux planificateurs contrôleraient les mêmes sites deux fois (§9).
- Le cœur ne ferme pas la base : `app.stop()` arrête le serveur et les tâches de fond ; c'est au point d'entrée d'appeler `closeDb()` (exporté par `src/db.js`) puis de quitter.
- Un seul `createApp` par processus : le planificateur, les notifications et la garde réseau sont des réglages de processus.

## 3. Les points d'extension

Toutes les options de `createApp` sont facultatives ; sans elles, le comportement est celui d'une installation personnelle.

### 3.1 `auth` — qui est l'utilisateur

```js
{
  kind: 'cloud',
  authenticate(req) → { user: { id, name }, account: { id } } | null,   // valeur ou promesse
  register({ route }) { /* routes publiques : connexion, déconnexion, état */ },
}
```

- `null` → la requête reçoit **401**. Les routes déclarées `{ public: true }` n'appellent pas `authenticate`.
- `account.id` est **obligatoire : un entier ≥ 1**. Sans lui, la requête est refusée (500) : jamais de repli silencieux sur le compte 1. `user` est libre (le cœur n'y lit que `name`, pour l'affichage).
- `register` doit déclarer au moins **`GET /api/auth`** public (état de connexion pour l'interface, et sonde de santé Docker). Une route déjà déclarée par le cœur est refusée au démarrage, même celle d'un fournisseur.
- **Ce que l'interface sait afficher.** `GET /api/auth` peut ajouter, en plus de `required` et `authenticated`, des champs facultatifs ; sans eux, l'écran est celui d'une installation classique :

  | Champ | Effet |
  |---|---|
  | `identifierLabel` | Libellé du premier champ de connexion (« Adresse e-mail » au lieu de « Identifiant ») |
  | `links: { signup, forgot }` | Liens « Créer un compte » et « Mot de passe oublié ? » sous le formulaire. **Chemins du même site** (`/…`) uniquement : tout autre lien (`javascript:`, autre domaine, `//hôte`) est ignoré |
  | `accountApi: true` | Remplace la carte « Sécurité » (identifiant du `.env`) par « Sécurité du compte », qui appelle les routes ci-dessous |

  **Double authentification.** Si `POST /api/login` répond `401` avec `{ error, code: 'needs_2fa' }`, l'écran affiche un champ de code et renvoie la demande avec `code` ; `code: 'invalid_2fa'` affiche le message du serveur. Plus généralement, `api()` côté interface conserve `status` et `code` de toute erreur, pour que les extensions puissent réagir à un code stable plutôt qu'à un texte.

  **Routes de la carte « Sécurité du compte »** (toutes derrière une session) : `GET /api/account/security` → `{ email, sessions, twofa: { available, enabled } }` ; `POST /api/account/password` `{ current, next }` ; `POST /api/account/sessions/revoke-others` → `{ revoked }` ; `POST /api/account/2fa/begin` → `{ secret, otpauth }` ; `POST …/2fa/enable` `{ code }` → `{ recoveryCodes }` ; `POST …/2fa/disable` `{ password, code }`. Le secret s'affiche en texte et en lien `otpauth://` : le cœur n'a aucune dépendance, donc pas de code QR.
- À fournir côté cloud : inscription, vérification d'e-mail, mot de passe oublié, hachage (`scrypt` est dans `node:crypto`), sessions révocables, limitation des tentatives par adresse **et** par compte, 2FA. Le fournisseur par défaut (`src/auth-env.js`) est un exemple minimal : un compte, cookie signé, 5 tentatives par minute et par IP, **en mémoire** (donc par processus).

### 3.2 `authorize(ctx, action, resource)` — le droit d'agir

Renvoie un booléen (ou une promesse). Défaut : tout est permis. Il est appelé :

- automatiquement, avec la `perm` de la route, **avant** la lecture du corps de la requête (un refus ne consomme rien et ne modifie rien) ;
- par `ctx.can(action, resource)` (booléen) et `ctx.require(action, resource)` (lève 403 « Accès refusé »), pour les contrôles propres à une route, avec la ressource concernée.

Actions des routes du cœur : `site:read`, `site:create`, `site:update`, `site:delete`, `site:check`, `site:ack`, `maintenance:write`, `group:read`, `group:write`, `alert:read`, `alert:ack`, `settings:read`, `settings:write`, `data:export`, `data:import`, `report:read`, `plugin:download`. S'y ajoute **`instance:write`** (modifier l'adresse publique de SuricateWeb, un réglage d'installation) : **à refuser aux comptes clients**. Le tableau complet route ↔ action est en annexe.

C'est ici que vit le partage d'accès : un invité « rapport » n'a que `report:read` (et `site:read` limité à ce qui lui est partagé) ; un invité « complet » a les actions de lecture et d'acquittement. `authorize` reçoit `ctx.user`, `ctx.account` et, pour les contrôles par ressource, la ressource.

> `authorize` décide du *droit*, pas de l'*appartenance* : un site d'un autre compte reste introuvable (404) quel que soit le droit. Pour qu'un invité voie les sites d'un autre compte, il faudra élargir `ctx.data` (§4) — c'est le point le plus délicat du partage d'accès.

### 3.3 `entitlements` — les quotas du forfait

```js
{
  check(ctx, action, details) { /* lève une HttpError pour refuser */ },
  limits(ctx) → { minIntervalMin?: number, screenshots?: boolean }   // plafonds ; {} si aucun
}
```

Le cœur appelle `check` dans trois cas :

| Action | Quand | Si refusé |
|---|---|---|
| `site:create` | création d'un site ; **chaque** site d'un import (au-delà du quota, les suivants sont ignorés et comptés dans `skipped`, sans erreur globale) | 402 (ou le statut de votre `HttpError`) |
| `site:enable` | reprise d'un site en pause | idem |

`limits().minIntervalMin` ramène un intervalle plus court au minimum autorisé, **sans refuser** la requête.

`limits().screenshots === false` (depuis 1.15) retire les **captures d'écran** du forfait :

- les captures planifiées et celles d'une alerte ne se lancent pas ; le site porte la raison (`shotError`) et la vérification reprend toutes les 30 min, ce qui rend un changement de forfait effectif sans action ;
- la capture manuelle répond **402** ; `GET /api/watches/:id/screenshots` et `GET /api/settings` renvoient `allowed: false`, et l'interface explique « non incluses dans votre forfait » au lieu de « navigateur introuvable » ;
- hors requête (planificateur, alertes), le cœur appelle `limits({ account: { id } })` **avec le seul compte** : ne comptez pas sur `ctx.user` ni sur la requête. Une erreur de `limits` n'arrête pas les captures (journalisée).

Les autres plafonds (rétention, pages par site, connecteur CMS, page de statut) sont à imposer vous-même, soit par `check`, soit dans vos routes, soit en filtrant la configuration reçue (voir §9).

À trancher côté cloud : un site en pause compte-t-il dans le quota ? Le cœur appelle `site:create` pour tout nouveau site et `site:enable` pour toute reprise ; c'est à votre `check` de compter comme le forfait l'exige. Que faire quand un compte dépasse son forfait après une rétrogradation (mettre les sites en trop en pause, ne **jamais** supprimer) est aussi de votre ressort.

### 3.4 `routes` — des routes supplémentaires

Chaque élément est une fonction qui reçoit `api` :

```js
function registerBilling({ route, app, HttpError, HANDLED, send, sendHtml }) {
  route('GET', '/api/billing', async (ctx) => ({ plan: await planOf(ctx.account.id) }), { perm: 'billing:read' });
  route('POST', '/api/billing/webhook', handleStripe, { public: true, raw: true });   // pas de session : la signature du corps brut authentifie
}
```

- Options : `{ public: true }` ou `{ perm: 'action' }`, et `{ raw: true }` pour recevoir le corps brut (ci-dessous). Une route privée sans `perm` n'est vérifiée que par l'authentification ; **déclarez toujours une `perm`**.
- Une route déjà déclarée (même méthode et même chemin) est refusée au démarrage.
- Un gestionnaire reçoit `ctx` : `req`, `res`, `params`, `query` (`URLSearchParams`), `body` (JSON déjà lu, `{}` en GET), `rawBody` (octets bruts, routes `raw` seulement), `headers` (en-têtes de réponse à ajouter), `app` (`info`, `root`, `env`, `capabilities`, `clientIp(req)`, `emit`), `user`, `account`, `data`, `can`, `require`, `entitle`, `limits`.
- Il renvoie un objet (réponse JSON 200), lève une `HttpError(status, message)` (le message est montré à l'utilisateur), ou écrit lui-même la réponse et renvoie `HANDLED`.
- Protection CSRF, valable pour vos routes aussi : une requête avec un corps non JSON est refusée (415), et une requête inter-sites sans corps sur une route privée l'est aussi (403).
- **Corps brut (`raw`).** Par défaut le corps JSON est lu et analysé avant le gestionnaire. Une route qui déclare `{ raw: true }` (ou `raw: <octets>` pour une autre limite que 2 Mo, plafonnée à 20 Mo) reçoit à la place **les octets exacts** dans `ctx.rawBody` (`Buffer`, vide s'il n'y a pas de corps) ; `ctx.body` vaut `{}`. C'est indispensable pour vérifier la signature d'un webhook (Stripe…), qui porte sur le corps tel qu'il a été envoyé : `JSON.stringify(JSON.parse(corps))` ne le restitue pas (espaces, ordre des clés, échappements). Sur une route brute, le contrôle « corps JSON uniquement » ne s'applique pas — la signature tient lieu d'authentification — mais le droit (`perm`) est vérifié **avant** la lecture du corps, et la taille reste limitée (413 au-delà).

  ```js
  route('POST', '/api/billing/webhook', (ctx) => {
    const event = stripe.webhooks.constructEvent(ctx.rawBody, ctx.req.headers['stripe-signature'], secret);  // lève si la signature est fausse
    return handleStripeEvent(event);
  }, { public: true, raw: true });
  ```

### 3.5 `hooks`

`onWatchCreated(ctx, site)`, `onWatchUpdated(ctx, site)`, `onWatchDeleted(ctx, id)`, `onStart(handle)`, `onStop(handle)`. Informatifs : une erreur est journalisée (`[hook nom]`) et **jamais** renvoyée au client. Ils servent à mesurer l'usage, pas à refuser (pour refuser : `entitlements`).

### 3.6 `notifier` — qui reçoit les alertes

```js
{ resolveChannels(site, alertes, réglages) → [canal…] }   // valeur ou promesse ; [] = personne

canal = {
  type, minSeverity, sendRecovery, wantsPhoto,
  send(site, alertes, réglages)  → promesse (rejetée si l'envoi échoue),
  sendPhoto?(image, légende)     → promesse,
}
```

Appelé à chaque contrôle qui produit des alertes, après le réglage « ne pas notifier » du site. Chaque canal reçoit les alertes qui lui reviennent selon sa gravité minimale. Une alerte est marquée « envoyée » si **au moins un** canal aboutit ; si tous échouent, l'erreur du dernier échec est conservée. Une seule capture est prise pour tous les canaux qui en veulent.

C'est le point d'ancrage des **canaux multiples par compte, groupe et site** : votre `resolveChannels` lit vos tables de canaux et de règles (portée compte, groupe ou site) et renvoie la liste. Le cœur fournit `telegramChannel(t, site)` pour construire un canal Telegram.

Pas de lecteur de boutons Telegram multi-comptes dans le cœur : le sien est lié au compte implicite et à un seul bot. Pour un bot partagé, prévoir un webhook (route `public` avec en-tête secret) qui retrouve le compte à partir de la conversation, **et vérifie que le site du bouton appartient à ce compte** avant de marquer des alertes comme lues (les fonctions `markAlertsReadUpTo` et `rememberDomainAck` ne vérifient pas le compte).

### 3.7 `scheduler`

`{ concurrency, pickDue(now, limite) }`. `pickDue` renvoie les identifiants des sites à contrôler (au plus `limite`), dans l'ordre voulu ; le défaut est « les plus en retard d'abord ». C'est ici qu'iront l'équité entre comptes (tourniquet : un gros compte ne doit pas affamer les petits) et les intervalles minimaux par forfait. Le passage a lieu toutes les 5 s ; il ne démarre pas tant que le précédent n'est pas fini, et une erreur est journalisée sans arrêter la surveillance.

### 3.8 `netGuard` — protection SSRF

`createNetGuard({ enabled, allowedPorts, allowHosts })` ; ou ses options ; ou `SURICATE_NET_GUARD=1` (+ `SURICATE_NET_ALLOW_PORTS`, `SURICATE_NET_ALLOW_HOSTS`). **À activer dès que des inconnus ajoutent des sites.** Voir `src/net-guard.js` pour le détail ; en résumé :

- refuse tout ce qui n'est pas http(s), les ports hors liste (80, 443, 8080, 8443 par défaut) et toute adresse privée ou réservée, écrite telle quelle ou renvoyée par le DNS ;
- vérifie l'adresse **dans le `lookup` de la connexion** : pas de fenêtre pour un « DNS rebinding » ;
- s'applique à chaque étape d'une redirection, au relevé CMS, au certificat TLS et aux captures ;
- refuse dès la saisie (400) une adresse interdite, avec la raison.

**Limite à connaître** : Chrome résout les adresses lui-même. Ses requêtes sont interceptées et vérifiées une à une, mais l'adresse jugée peut différer de celle de la connexion. Pour une garantie complète, faites tourner Chrome dans un conteneur ou un réseau **sans accès à l'interne** (§7).

### 3.9 `capabilities`

Fusionné dans `GET /api/capabilities` (public), avec `{ mode: 'self-hosted', multiUser: false, billing: false, version }` par défaut. L'interface s'en sert pour afficher ou masquer des écrans (le contrôle réel reste côté serveur). Depuis 1.15, elle lit aussi :

| Clé | Effet |
|---|---|
| `accountLinks: [{ label, href }]` | liens affichés sous le menu de la barre latérale (ex. « Mon forfait »). `href` : un chemin du même site (`/…`), tout autre lien est ignoré |
| `usageUrl: '/api/…'` | jauge d'usage : l'interface fait `GET` sur cette adresse (avec la session) et lit `{ plan: { name }, usage: { sites: { active, max } } }` ; `max: null` = illimité. Elle se rafraîchit à chaque changement de page, au plus toutes les 4 s |

Sans ces clés (cœur auto-hébergé), rien n'est affiché.

### 3.10 `home`

`home({ req, res, identity }) → booléen` : appelé pour `GET` et `HEAD` sur « / » (et eux seuls), avant le service du dossier `public/`. `identity` est le résultat de `auth.authenticate(req)`, ou `null` sans session valide. Renvoyer `true` signifie « j'ai répondu » (ex. une page de présentation pour les visiteurs) ; `false`, l'application est servie comme sans cette option.

- Une erreur du gestionnaire **ou** de l'authentification ne bloque jamais l'application : elle est servie (et l'identité transmise est alors `null`).
- La réponse à « / » dépend de la session : le cœur pose `Vary: Cookie` dès que `home` est défini. Le gestionnaire doit répondre avec `Cache-Control: no-cache` (ou `private`).
- `/index.html` reste l'application, avec ou sans session : c'est l'adresse à donner à un bouton « Se connecter » de la page d'accueil.
- Le service worker de l'application met « / » en cache : hors ligne, un visiteur qui a déjà ouvert l'application peut retrouver celle-ci à la place de la page. Sans conséquence (l'application ne fonctionne pas hors ligne).

## 4. Les données : ctx.data

**Règle** : une route n'importe jamais directement les fonctions de `src/db.js` qui lisent ou écrivent par identifiant ou par liste. Elle passe par `ctx.data`, créé pour le compte de l'utilisateur :

| Domaine | Fonctions |
|---|---|
| Sites | `getWatch(id)` (null si autre compte), `requireWatch(id)` (404), `listWatches()`, `createWatch(data)` |
| Groupes | `getGroup`, `listGroups`, `createGroup`, `updateGroup`, `deleteGroup`, `applyLayout` |
| Dépendances d'un site | `getSnapshot(id)`, `getScreenshot(id)`, `endMaintenance(id)` — on remonte au site pour contrôler son compte |
| Alertes | `queryAlerts(filtres)`, `markEveryAlertRead()`, `markAlertsRead(ids)` |
| Tableau de bord | `unreadAlertCounts`, `domainExpiryAlertState`, `checkStatsSince`, `sparklines`, `latestScreenshots`, `activeMaintenanceMap`, `screenshotUsage` |

Les fonctions qui prennent l'identifiant d'un site **déjà obtenu par `ctx.data`** (`recentChecks(w.id)`, `listMaintenance(w.id)`, `uptimeSummary(w)`…) sont sûres : l'appartenance a été contrôlée. Conséquences pour vos routes :

- obtenir le site par `ctx.data.requireWatch(id)` **avant** toute lecture ou écriture qui en dépend ;
- une ressource étrangère répond 404, jamais 403 (ne rien révéler de son existence) ;
- ne jamais appeler `listWatches()`, `getGroup()`… de `db.js` sans compte depuis une route.

À savoir, les fonctions de `db.js` prennent `accountId = null` pour « toute l'installation » (planificateur, contrôles, tests) ; une valeur renseignée cloisonne. Les fonctions qui **créent** des lignes prennent le compte 1 par défaut : `ctx.data` fixe toujours le compte.

**Supprimer un compte** n'a pas de fonction dédiée dans le cœur. Pour chaque site : `deleteWatch(id)` (les contrôles, alertes, versions, captures — lignes —, pannes et maintenances partent par cascade) puis `removeWatchShots(id)` (les **fichiers** d'images, dans `DATA_DIR/screenshots/<id>`, ne partent pas tout seuls) ; puis les groupes (`deleteGroup`) ; puis la ligne de réglages `account:<id>` de la table `settings`. À écrire côté cloud, avec les obligations RGPD d'effacement et d'export.

## 5. Les réglages à deux niveaux

| Niveau | Contenu | Stockage | Accès |
|---|---|---|---|
| Installation | secret de session, adresse publique (`baseUrl`), rétention des contrôles et des versions | ligne `app` | `getInstanceSettings()` (synchrone), `saveInstanceSettings(patch)` |
| Compte | Telegram, mots-clés, User-Agent, intervalle par défaut, seuil des mises à jour CMS, conservation des captures | ligne `account:<id>` | `accountSettings(id)`, `saveAccountSettings(id, patch)` |

`settingsFor(compteId)` donne la **vue fusionnée** (installation + compte) que reçoivent contrôles, messages et relevés. `getSettings()` (synchrone) est la vue du **compte implicite 1** : à ne pas utiliser dans du code multi-comptes. Un compte sans ligne a les valeurs par défaut (`accountDefaults()`). Les réglages d'un compte sont relus au bout de 30 s : une modification faite par un autre processus est vue dans ce délai.

**Chiffrement des jetons Telegram.** Par défaut le jeton du bot est stocké en clair dans la ligne de réglages du compte. `configureStore({ secrets: { seal, open } })` le chiffre au repos : `seal(texte)` renvoie un texte préfixé `v1:` (AES-GCM, par exemple), `open` fait l'inverse. En mémoire et dans l'API, le jeton reste en clair ; en base, jamais. Une valeur sans préfixe est du clair d'avant le chiffrement : elle reste lisible et se chiffre à la prochaine écriture, ou tout de suite avec `sealStoredSecrets()` (à appeler au démarrage). Si la clé change ou se perd, le jeton d'un compte est considéré absent (message dans les journaux, à ressaisir) au lieu de faire tomber le service ; un jeton chiffré sans aucun codec configuré lève une erreur explicite.

À décider côté cloud : si la rétention des contrôles devient un réglage de forfait (aujourd'hui d'installation).

## 6. Le moteur de base de données

### Contrat de l'adaptateur

Voir l'en-tête de `src/store/sqlite.js`. En résumé : `dialect`, `all`, `get`, `run → { changes }`, `insert → id`, `exec`, `transaction(fn(tx))`, `close`. Toutes les méthodes peuvent renvoyer une valeur ou une promesse. Pour PostgreSQL, l'adaptateur doit :

- traduire les `?` en `$1, $2…` ;
- ajouter `RETURNING id` à `insert` (tables avec colonne `id` uniquement ; `daily_stats` et `settings` passent par `run`) ;
- renvoyer **tous les nombres en `Number`** : `COUNT`, `SUM`, `AVG`, `BIGINT` (horodatages en ms) sortent de `pg` en texte par défaut — régler les analyseurs de types (`int8`, `numeric`) ;
- garder des entiers 0/1 pour les indicateurs, et un `Buffer` pour les colonnes `BYTEA` (versions de page compressées) ;
- exécuter `transaction(fn)` sur **une connexion réservée** et passer `tx` à `fn` : tout ce qui est lu dans la transaction doit passer par `tx` (le cœur le fait pour la suppression de groupe et la réorganisation) ;
- accepter `exec` avec plusieurs instructions.

### Tests de contrat

```js
import { adapterContract } from '<cœur>/test-support/adapter-contract.js';
adapterContract({ name: 'postgres', open: async () => openPostgresVide() });   // un adaptateur NEUF et vide à chaque test
```

Dix tests : identifiants, paramètres et `NULL`, nombres, octets, `"end"`, upsert, transactions (validation, annulation, lecture de ses propres écritures). **Ils n'ont été joués que sur SQLite** : le contrat n'a jamais tourné contre un vrai pilote PostgreSQL. C'est la première chose à faire dans le dépôt cloud.

### Migrations

- Le cœur occupe les numéros 1 à 999 ; **les migrations d'extension portent des numéros ≥ 1000**.
- Chaque migration a une fonction par moteur utilisé (`sqlite`, `postgres`) ; une migration publiée ne change plus.
- Elles s'appliquent dans l'ordre, chacune dans sa transaction, au démarrage.
- **Pas de verrou entre processus** : si plusieurs processus démarrent en même temps sur la même base PostgreSQL, ils peuvent appliquer la même migration. Prendre un verrou consultatif (`pg_advisory_lock`) autour de la migration, dans le point d'entrée et AVANT d'importer le cœur : le migrateur de `db.js` ne trouve alors plus rien à faire. La version hébergée le fait (`migrateLocked`, dépôt privé).
- Pas de table `accounts` dans le cœur : la vôtre en créera une (clé étrangère facultative depuis `watches.account_id` et `site_groups.account_id`, qui sont de simples entiers avec défaut 1).

### Ce qui a été vérifié, et comment

L'adaptateur de la version hébergée (dépôt privé, pilote `pg`) a fait tourner **toute la suite de tests du cœur sur PostgreSQL 17**, sans modifier les tests : un préchargement redirige `configureStore` vers PostgreSQL, avec un schéma par dossier de données, comme SQLite a un fichier par dossier. Résultat : tous les tests passent, sauf ceux qui vérifient SQLite lui-même (ils préparent ou lisent directement un fichier `suricate.db`).

Ce rejeu a trouvé **une** vraie différence de dialecte, corrigée en 1.9.2 : un alias en camelCase non cité (`AS finalUrl`) est passé en minuscules par PostgreSQL (`finalurl`), donc la propriété `finalUrl` d'une capture revenait `undefined`. Règle : un alias en camelCase s'écrit entre guillemets (`AS "finalUrl"`). `test/sql-portable.test.js` l'interdit, avec d'autres constructions SQLite-seulement (`PRAGMA`, `LIMIT -1`, `COLLATE NOCASE`, `INSERT OR IGNORE`…).

Ce qui reste hors de portée de ces tests : la charge (requêtes lentes avec beaucoup de données), les coupures de connexion en cours de route, et les plans d'exécution. Les index du cœur ont été pensés pour SQLite ; `EXPLAIN` sur des volumes réels est à faire avant l'ouverture.

## 7. Sécurité : avant d'ouvrir les inscriptions

- [ ] **Garde réseau activée** (`netGuard`), avec la liste de ports voulue.
- [ ] **Chrome isolé.** L'image Docker du cœur lance Chrome avec `CHROME_NO_SANDBOX=1` (le bac à sable exige des privilèges que Docker n'accorde pas). Avec des sites inconnus, c'est une surface d'attaque : exécuter Chrome dans un conteneur dédié, sans accès à la base ni aux secrets, ni au réseau interne, avec un vrai bac à sable (profil seccomp, ou machine à part). Les captures sont alors à produire par ce worker : le cœur le permet avec `CHROME_WS_URL` (voir ci-dessous), la mise en place du conteneur restant côté exploitation.
- [ ] **`instance:write` refusé** aux comptes clients.
- [ ] **Secrets chiffrés** : jetons Telegram (§5), et tout secret que vous ajoutez.
- [ ] **Authentification complète** (§3.1) : hachage, e-mail vérifié, limitation des tentatives par compte, 2FA.
- [ ] **Anti-abus** : un compte gratuit ne doit pas servir à surveiller ou capturer à haute fréquence un site tiers. Leviers : `limits().minIntervalMin`, quotas de captures, `User-Agent` identifiable avec un contact, vérification de propriété du domaine pour les fonctions agressives.
- [ ] **Limitation de débit** : celle du cœur est en mémoire et par processus (connexion : 5 par minute et par IP ; page de statut : 120 par minute et par IP). Insuffisant derrière plusieurs processus.
- [ ] **`TRUST_PROXY=1`** derrière un reverse proxy : sinon `clientIp` voit l'adresse du proxy ; sans proxy de confiance, ne **pas** l'activer (l'en-tête `X-Forwarded-For` serait falsifiable).
- [ ] **Pages de statut publiques** : le jeton est l'unique accès ; unique dans toute l'installation (vérifié), mais la recherche se fait par `LIKE` sur toute la table `watches` (§9).

## 8. Les garde-fous à reprendre ou à étendre

Tests du cœur qui doivent rester verts, et dont le dépôt cloud doit s'inspirer :

| Test | Ce qu'il garantit |
|---|---|
| `test/account-isolation.test.js` | chaque route à paramètre, essayée avec les identifiants d'un autre compte → 404 ; **échoue si une route privée à paramètre n'est pas dans la matrice** ; les routes n'importent pas les fonctions non cloisonnées de `db.js` ; flux temps réel filtré. Comptes de test 10 et 20, jamais 1. |
| `test/app-extensions.test.js` | chaque option de `createApp`, et : **toute route privée du cœur déclare une `perm`** (sauf `GET /api/me`). |
| `test/account-settings.test.js` | réglages par compte (User-Agent, mots-clés, Telegram sans croisement). |
| `test/net-guard.test.js` | adresses refusées, client HTTP équivalent à `fetch`, Chrome réel intercepté. |
| `test-support/adapter-contract.js` | contrat de l'adaptateur (§6). |

Pour vos propres routes : ajoutez-les à une matrice d'isolation équivalente, avec un faux fournisseur d'authentification (`{ authenticate: req => USERS[req.headers['x-user']], register }`, voir le haut de `test/app-extensions.test.js`).

## 9. Limites connues du cœur

À lever dans le cœur ou à contourner côté cloud :

| Limite | Effet | Piste |
|---|---|---|
| Planificateur **sans réservation** | deux processus contrôleraient les mêmes sites | `pickDue` qui réserve (`UPDATE … SET next_run = … RETURNING`), ou un seul processus de planification |
| Bus d'événements **en mémoire** (`src/events.js`) | un worker séparé n'alimente pas le temps réel des processus web ; chaque connexion SSE ajoute un écouteur (plafond réglé à 100) | `LISTEN/NOTIFY` PostgreSQL ou Redis, et revoir le plafond |
| Captures sur **disque local** (`DATA_DIR/screenshots`) | pas de multi-machines ; pas de quota disque | stockage objet derrière une interface, quota par forfait |
| Quotas : seul l'intervalle est plafonné (`limits`) | captures, rétention, pages par site, connecteur CMS, page de statut : à imposer vous-même | étendre `limits()` si le besoin se confirme |
| `GET /api/watches` **non paginé**, avec une requête par site pour la courbe (`sparklines`) | lent pour un compte de centaines de sites | pagination, requête unique |
| Barres de disponibilité : 90 × 2 requêtes par site affiché | idem | agréger côté SQL |
| Page de statut : jeton cherché par `LIKE '%jeton%'` sur `watches.config` | parcours complet de la table | colonne `status_token` indexée |
| Lecteur Telegram du cœur : un bot, le compte 1 | inutilisable en multi-comptes | webhook côté cloud (§3.6) |
| Relevé CMS et contrôles : mêmes `fetch` globaux sans limitation par compte | un compte peut saturer le serveur | `pickDue` équitable, `concurrency` |
| Disponibilité mesurée depuis **un seul point** | une panne réseau du serveur ressemble à une panne du site | sondes multi-régions (hors périmètre actuel) |

## 10. Ce qu'une couche hébergée doit construire

Chaque besoin dit où il s'accroche. Le plan détaillé, les forfaits et les décisions produit relèvent du dépôt de la couche hébergée, pas du cœur.

| Besoin | S'accroche à |
|---|---|
| **Moteur de base** autre que SQLite : adaptateur, tests de contrat, migrations | `configureStore` |
| **Comptes et utilisateurs** : inscription, vérification d'e-mail, sessions, mot de passe oublié, 2FA, invitations | `auth`, migrations ≥ 1000, routes |
| **Durcissement** : garde réseau, Chrome isolé, secrets chiffrés, anti-abus | `netGuard`, worker de capture |
| **Quotas et droits** : limites par compte, jauges d'usage | `entitlements`, `authorize`, `capabilities`, `hooks`, routes |
| **Paiement** : webhooks idempotents, rétrogradation sans suppression | routes (`{ public: true, raw: true }` : signature sur le corps brut), `entitlements` |
| **Partage et notifications** : accès par groupe ou site, canaux multiples | `authorize` + élargissement de `ctx.data`, `notifier`, routes |
| **Exploitation** : séparation web/worker, équité du planificateur, sauvegardes, effacement et export de données, pages légales | `scheduler`, hooks, déploiement |

## 11. Compatibilité et versions

- Le cœur suit un numéro `x.y.z` dans `package.json` (source unique, affichée dans l'interface) : correctif → `z`, nouvelle fonction → `y`. Une modification qui **casse** un contrat décrit ici (signature d'une option, d'un hook, de `ctx.data`, de l'adaptateur) devra passer en `2.0.0` et être annoncée.
- Les migrations du cœur ne sont jamais modifiées une fois publiées : on en ajoute une. Les vôtres, numérotées à partir de 1000, suivent la même règle.
- Embarquer le cœur par sous-module Git épinglé sur une version ; lire les commits entre deux versions avant de mettre à jour.

## Annexe A — Routes et permissions (version 1.8.0)

| Permission | Routes |
|---|---|
| *(publique, sans connexion)* | `GET /api/auth` · `POST /api/login` · `POST /api/logout` · `GET /api/capabilities` |
| `alert:ack` | `POST /api/alerts/read` |
| `alert:read` | `GET /api/alerts` |
| `data:export` | `GET /api/export` |
| `data:import` | `POST /api/import` |
| `group:read` | `GET /api/groups` |
| `group:write` | `POST /api/groups` · `PUT /api/groups/:id` · `DELETE /api/groups/:id` · `PUT /api/layout` |
| `maintenance:write` | `POST /api/watches/:id/maintenance` · `DELETE /api/maintenance/:id` |
| `plugin:download` | `GET /api/plugins/:file` |
| `report:read` | `GET /api/watches/:id/report` · `GET /api/groups/:id/report` |
| `settings:read` | `GET /api/settings` |
| `settings:write` | `PUT /api/settings` · `POST /api/telegram/test` · `POST /api/telegram/detect` |
| `site:ack` | `POST /api/watches/:id/ack` · `POST /api/watches/:id/cms/admins/accept` |
| `site:check` | `POST /api/watches/:id/check` · `POST /api/watches/:id/screenshot` · `POST /api/watches/:id/cms` |
| `site:create` | `POST /api/watches` · `POST /api/test-url` |
| `site:delete` | `DELETE /api/watches/:id` |
| `site:read` | `GET /api/watches` · `GET /api/watches/:id` · `GET /api/watches/:id/uptime` · `GET /api/watches/:id/series` · `GET /api/watches/:id/domain` · `GET /api/watches/:id/history` · `GET /api/snapshots/:id/diff` · `GET /api/snapshots/:id/text` · `GET /api/watches/:id/screenshots` · `GET /api/screenshots/:id/image` · `GET /api/events` |
| `site:update` | `PUT /api/watches/:id` · `POST /api/watches/:id/toggle` |
| *(aucune : connexion seule)* | `GET /api/me` |

44 routes. `GET /api/auth`, `POST /api/login` et `POST /api/logout` viennent du fournisseur d'authentification par défaut ; le vôtre déclare les siennes.


## Annexe B — Événements du flux temps réel

`running`, `idle` (un contrôle démarre, se termine), `check` (contrôle terminé, avec le nombre d'alertes), `shot` (capture), `ack` (acquittement), `layout` (réorganisation des groupes). Chaque événement porte `watchId` ou `accountId` ; un événement dont le compte est inconnu n'est transmis à personne. Si vous émettez les vôtres sur `bus` (`src/events.js`), mettez-y `accountId`.

## Annexe C — Variables d'environnement lues par le cœur

| Variable | Rôle |
|---|---|
| `DATA_DIR` | dossier des données (base SQLite par défaut, captures) |
| `PORT`, `HOST` | écoute (dans `server.js` ; `createApp` n'écoute qu'à l'appel de `listen`) |
| `SURICATE_USER`, `SURICATE_PASSWORD` | identifiants du fournisseur par défaut (inutiles avec votre `auth`) |
| `TRUST_PROXY` | lire `X-Forwarded-*` derrière un reverse proxy de confiance |
| `TELEGRAM_POLL` | `0` désactive le lecteur des boutons Telegram (à faire en multi-comptes) |
| `TELEGRAM_API` | adresse de l'API Telegram (tests) |
| `SURICATE_DEMO` | `1` : données fictives, aucun contrôle ni capture |
| `SURICATE_NET_GUARD`, `SURICATE_NET_ALLOW_PORTS`, `SURICATE_NET_ALLOW_HOSTS` | garde réseau |
| `CHROME_PATH`, `CHROME_NO_SANDBOX`, `CHROME_WS_URL`, `SCREENSHOT_CONCURRENCY` | Chrome (local ou distant) et captures |
| `ENV_FILE` | emplacement du `.env` (chargé seulement par `server.js`) |

## Chrome distant (`CHROME_WS_URL`)

Si `CHROME_WS_URL` (`ws://` ou `wss://`) est défini, le cœur ne lance aucun Chrome : il se connecte à ce navigateur par le protocole DevTools et capture dedans. Ce que cela garantit :

- **Un contexte de navigation par capture** (`Target.createBrowserContext`), détruit à la fin : deux sites ne partagent ni cookies ni stockage. Le navigateur distant, lui, reste en service.
- **La garde réseau s'applique toujours** : elle passe par `Fetch.enable`, donc par le protocole, et juge chaque requête de la page avant son départ.
- **L'adresse est un secret** (elle porte souvent un jeton) : elle n'apparaît ni dans les messages d'erreur, ni dans les réglages, ni dans l'API (l'interface affiche « Chrome distant »).
- Une adresse invalide désactive les captures ; elle ne retombe **pas** sur un Chrome local.
- `SURICATE_CAPTURES=0` coupe toujours les captures, distantes comprises.

Côté exploitation : le conteneur Chrome doit être sur un réseau SANS accès à la base ni aux autres services internes, ne jamais être publié, avoir un jeton, et plafonner sa concurrence et sa durée de session au-delà de la capture la plus longue du cœur (environ 60 s).
