# Politique de sécurité

SuricateWEB surveille des sites web : une faille dans SuricateWEB touche donc potentiellement tous les sites qu'il surveille. Les signalements de vulnérabilité sont les bienvenus.

## Signaler une vulnérabilité

**Ne publiez pas la faille dans une issue ni dans une discussion publique.**

Utilisez le signalement privé de GitHub : onglet **Security** du dépôt › **Report a vulnerability**
([lien direct](https://github.com/burotica49/VigieWeb/security/advisories/new)). Seuls les mainteneurs voient votre message.

Indiquez si possible :

- la version de SuricateWEB (visible sous le nom dans la barre latérale) et le mode de déploiement (Docker, Node direct) ;
- une description de la faille et de son impact ;
- les étapes pour la reproduire (requête, configuration, preuve de concept minimale) ;
- une éventuelle piste de correction.

N'envoyez jamais de vrais identifiants, jetons ou données de clients : des valeurs fictives suffisent.

## Ce qui suit un signalement

SuricateWEB est maintenu par une petite équipe, sans engagement de délai contractuel. Nous nous efforçons d'accuser réception rapidement, de confirmer ou non la faille, de publier un correctif, puis de vous créditer dans l'avis de sécurité si vous le souhaitez. Merci de ne rien divulguer avant la publication du correctif.

## Versions prises en charge

Seule la **dernière version** publiée sur la branche `main` reçoit des correctifs de sécurité.

## Périmètre

Dans le périmètre :

- le serveur SuricateWEB (authentification, API, interface, planificateur, captures d'écran) ;
- l'image Docker et son script de démarrage ;
- les plugins WordPress et PrestaShop (`plugins/`), notamment leur contrôle d'accès par jeton.

Hors périmètre :

- les sites que SuricateWEB surveille ;
- les failles qui exigent déjà un accès administrateur à SuricateWEB ou au serveur qui l'héberge ;
- les comportements documentés dans le [README](README.md), par exemple le fait qu'un utilisateur connecté puisse faire interroger des adresses arbitraires par le serveur ;
- les attaques par déni de service volumétriques.

## Bonnes pratiques de déploiement

- Placez SuricateWEB **derrière HTTPS** (reverse proxy) dès qu'il est exposé hors de votre machine.
- Choisissez un mot de passe long dans `SURICATE_PASSWORD` et ne partagez pas l'accès : un utilisateur connecté a la main sur toute la surveillance.
- Ne versionnez jamais le fichier `.env`.
- Surveillez vos sites WordPress et PrestaShop **en HTTPS** : le jeton du plugin transite dans un en-tête de requête.
