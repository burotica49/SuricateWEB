# SuricateWeb — consignes pour Claude

## Version

À chaque modification du projet, incrémenter la version dans `package.json` (source unique, affichée dans la barre latérale) dans le même commit :

- correctif : `x.y.Z` ;
- nouvelle fonction : `x.Y.0`.

Si le changement touche un plugin (`plugins/`), mettre aussi à jour sa version (en-tête du plugin WordPress, `config.xml` et `suricateweb.php` du module PrestaShop) et régénérer les archives `plugins/*.zip`.

## Tests

`npm test` échoue avec cette version de Node ; utiliser :

```bash
node --disable-warning=ExperimentalWarning --test test/*.test.js
```

Le test Chrome « aucun Chrome orphelin » (`test/screenshot.test.js`) échoue dans les conteneurs cloud, indépendamment du code.

## Langue

Interface, messages, commentaires et documentation en français.
