# Créer le webhook Stripe

Guide pas à pas pour brancher les paiements Stripe sur une couche hébergée SuricateWeb : créer le point de terminaison côté Stripe, écrire la route qui le reçoit, la tester en local, puis la mettre en production.

> **Où vit ce code ?** Le cœur de SuricateWeb ne contient **aucun code Stripe** : il fournit seulement le mécanisme (route publique à corps brut, quotas par forfait). La route, le secret et le traitement des événements s'écrivent dans le dépôt de la couche hébergée. Références : [couche-cloud.md §3.4](couche-cloud.md) (routes `raw`), §3.3 (`entitlements`) et §10 (paiement).

## 1. Principe

1. Un client paie ou change d'abonnement sur Stripe (Checkout, portail client…).
2. Stripe envoie un `POST` signé à votre URL, par exemple `https://suricate.exemple.fr/api/billing/webhook`.
3. Votre route **vérifie la signature** sur les octets exacts du corps, puis met à jour le forfait du compte.
4. Elle répond `2xx` vite ; sinon Stripe réessaie (jusqu'à plusieurs jours en mode live, avec un délai croissant).

Trois règles gouvernent tout le reste :

- **Corps brut** : la signature porte sur le corps tel qu'il a été envoyé. Déclarez la route avec `{ public: true, raw: true }` et lisez `ctx.rawBody` ; `JSON.stringify(ctx.body)` ne restitue pas les mêmes octets.
- **Idempotence** : Stripe peut envoyer deux fois le même événement, ou dans le désordre. Le traitement doit pouvoir être rejoué sans effet de bord.
- **Jamais de suppression** : une rétrogradation met les sites en trop **en pause**, elle ne les supprime pas (§3.3 de `couche-cloud.md`).

## 2. Prérequis

- Un compte Stripe, avec ses **produits et prix** créés (un prix par forfait ; notez leurs identifiants `price_…`).
- Le paquet officiel dans la couche hébergée : `npm install stripe`.
- Deux variables d'environnement **de la couche hébergée** (le cœur ne les lit pas, elles n'apparaissent donc pas dans l'annexe C) :

| Variable | Contenu |
|---|---|
| `STRIPE_SECRET_KEY` | clé API secrète (`sk_test_…` ou `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | secret de signature du point de terminaison (`whsec_…`, voir §4) |

> Ne mettez jamais ces valeurs dans le code, la documentation ou un commit : uniquement dans l'environnement du serveur (Dokploy, Docker…) ou dans un `.env` non versionné.

Stripe sépare le **mode test** et le **mode live** : clés, points de terminaison et secrets de signature sont **différents** dans chaque mode. Commencez en test.

## 3. Écrire la route

Exemple minimal, à adapter à votre modèle de comptes (`planOf`, `setPlan`, `pauseExtraSites` sont à vous). Il suppose une table `stripe_events` créée par une de vos migrations (identifiants ≥ 1000, voir §6 de `couche-cloud.md`) pour mémoriser les événements déjà traités.

```js
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Événements à traiter : ce sont aussi ceux à cocher dans le tableau de bord Stripe (§4).
const HANDLED_EVENTS = new Set([
  'checkout.session.completed',        // premier paiement : rattacher le client Stripe au compte
  'customer.subscription.created',
  'customer.subscription.updated',     // changement de forfait, renouvellement, passage en « impayé »
  'customer.subscription.deleted',     // résiliation
  'invoice.payment_failed',            // informatif (relance) : l'abonnement passera en past_due / canceled
]);

function registerBilling({ route, HttpError }) {
  route('POST', '/api/billing/webhook', async (ctx) => {
    // 1. Authentification : la signature tient lieu de session. constructEvent lève si elle est fausse,
    //    ou si l'horodatage a plus de 5 minutes (protection contre le rejeu).
    let event;
    try {
      event = stripe.webhooks.constructEvent(ctx.rawBody, ctx.req.headers['stripe-signature'], WEBHOOK_SECRET);
    } catch {
      // 400 : Stripe ne doit pas réessayer inutilement un appel qui n'est pas de lui.
      throw new HttpError(400, 'Signature invalide');
    }

    // 2. Événement hors liste : on répond 200 pour que Stripe n'insiste pas.
    if (!HANDLED_EVENTS.has(event.type)) return { received: true, ignored: true };

    // 3. Idempotence : on réserve l'identifiant AVANT de traiter, dans la même transaction que l'effet.
    //    Si l'insertion échoue (déjà vu), c'est un rejeu : on répond 200 sans rien refaire.
    const firstTime = await markEventSeen(event.id);
    if (!firstTime) return { received: true, duplicate: true };

    try {
      await applyEvent(event);
    } catch (err) {
      // On libère la réservation et on répond 500 : Stripe réessaiera plus tard.
      await forgetEvent(event.id);
      throw err;
    }
    return { received: true };
  }, { public: true, raw: true });
}

async function applyEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      // client_reference_id : l'identifiant de compte que VOUS avez passé en créant la session Checkout.
      await linkStripeCustomer(Number(s.client_reference_id), s.customer);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // Les événements peuvent arriver dans le désordre : on relit l'état courant chez Stripe
      // plutôt que de se fier à la charge utile reçue.
      const sub = await stripe.subscriptions.retrieve(event.data.object.id);
      const account = await accountOfCustomer(sub.customer);
      const active = ['active', 'trialing'].includes(sub.status);
      const plan = active ? planOfPrice(sub.items.data[0].price.id) : 'free';
      await setPlan(account.id, plan);
      // Rétrogradation : mettre en pause les sites au-delà du quota, ne JAMAIS les supprimer.
      await pauseExtraSites(account.id);
      break;
    }
    case 'invoice.payment_failed':
      await notifyPaymentFailed(event.data.object.customer);
      break;
  }
}
```

Points à ne pas oublier :

- Le forfait lu par `entitlements.check` et `limits` doit venir de **votre base** (mise à jour ici), jamais d'un appel à Stripe à chaque requête.
- Vérifiez que le traitement reste rapide : Stripe attend une réponse en quelques secondes. Un travail long (envoi d'e-mails, pauses en masse) se met en file d'attente.
- Journalisez `event.id` et `event.type`, jamais la charge utile entière (elle contient des données de client).

## 4. Créer le point de terminaison dans Stripe

1. Connectez-vous au [tableau de bord Stripe](https://dashboard.stripe.com) et choisissez le **mode** (interrupteur « Mode test » / live).
2. Ouvrez **Développeurs › Webhooks** (ou **Workbench › Webhooks** selon l'interface de votre compte), puis **Ajouter un point de terminaison**.
3. **URL du point de terminaison** : `https://<votre-domaine>/api/billing/webhook` (HTTPS obligatoire en mode live).
4. **Événements à envoyer** : cochez exactement ceux de `HANDLED_EVENTS` (§3).
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
5. Validez, puis ouvrez le point de terminaison créé et cliquez sur **Révéler** dans « Clé secrète de signature » : c'est la valeur `whsec_…`.
6. Placez-la dans `STRIPE_WEBHOOK_SECRET` sur le serveur et **redéployez** (la variable n'est lue qu'au démarrage).
7. Refaites les étapes 1 à 6 en **mode live** avec l'autre secret quand vous passerez en production.

> Le secret `whsec_…` du tableau de bord n'est **pas** celui de la CLI Stripe (§5) : chacun signe avec le sien.

## 5. Tester en local avec la CLI Stripe

La [CLI Stripe](https://docs.stripe.com/stripe-cli) transmet les événements du mode test à votre machine, sans exposer de port sur Internet.

```bash
stripe login
```

```bash
stripe listen --forward-to localhost:3000/api/billing/webhook
```

`stripe listen` affiche un secret `whsec_…` propre à cette session : lancez votre serveur avec **cette** valeur dans `STRIPE_WEBHOOK_SECRET` (3000 est le port par défaut de SuricateWeb, voir `PORT`). Dans un autre terminal :

```bash
stripe trigger customer.subscription.updated
```

Vérifiez :

- la CLI affiche `[200]` pour chaque événement ;
- le forfait du compte change bien en base ;
- **rejouez** le même événement (`stripe events resend evt_…`) : la réponse doit être `200` avec `duplicate: true`, et aucun second effet ;
- un événement avec une fausse signature (`curl -X POST localhost:3000/api/billing/webhook -d '{}'`) répond **400**.

Un test automatisé de la route, sans Stripe, suit le modèle de `test/raw-body.test.js` : il fabrique l'en-tête `Stripe-Signature` (`t=<horodatage>,v1=<HMAC-SHA256 de "<horodatage>.<corps>">`) avec `stripe.webhooks.generateTestHeaderString`.

## 6. Mise en production

- [ ] Point de terminaison **live** créé, avec son propre `whsec_…`, et clés `sk_live_…` en place.
- [ ] L'URL est joignable depuis Internet en HTTPS, **sans authentification devant** (pas de protection d'accès, de pare-feu applicatif ni de redirection `http → https` qui transformerait le `POST` en `GET`).
- [ ] Le reverse proxy ne modifie pas le corps (pas de recompression ni de réécriture) ; `TRUST_PROXY` est réglé si vous lisez l'adresse du client.
- [ ] La table des événements traités existe (migration appliquée) et le traitement est rejouable.
- [ ] Un paiement réel de test (petit montant, puis remboursement) fait bien passer le compte au bon forfait.
- [ ] Une résiliation de test met les sites en trop **en pause**, sans rien supprimer.
- [ ] Un suivi des échecs est en place : dans Stripe, la page du point de terminaison liste chaque tentative, sa réponse et permet de **renvoyer** un événement.

## 7. Dépannage

| Symptôme | Cause probable |
|---|---|
| **400 « Signature invalide »** | mauvais secret (test ↔ live, tableau de bord ↔ CLI) ; corps modifié en route (proxy) ; route non déclarée `raw: true` ; horloge du serveur décalée de plus de 5 minutes |
| **404** | mauvaise URL, ou la route n'est pas enregistrée (vérifier `routes` dans `createApp`) |
| **401 / 403 / redirection** | la route n'est pas `public: true`, ou un composant devant le serveur exige une connexion |
| **413** | corps au-delà de la limite de la route (2 Mo par défaut ; `raw: <octets>` pour la relever) |
| **200 mais rien ne change** | événement non coché dans Stripe, ou rejeté comme doublon (vérifier la table des événements traités) |
| **Stripe désactive le point de terminaison** | échecs répétés pendant plusieurs jours : corrigez, puis réactivez-le et renvoyez les événements manqués depuis le tableau de bord |
