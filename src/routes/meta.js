// Qui suis-je, et que propose cette installation ? Lu par l'interface pour afficher ou masquer des écrans
// (le contrôle réel reste toujours côté serveur : voir `perm` sur les routes).

export default function register({ route }) {
  // Identité de la requête : utilisateur et compte fournis par le fournisseur d'authentification.
  route('GET', '/api/me', (ctx) => ({ user: ctx.user, account: ctx.account }));

  // Public : l'écran de connexion de la version hébergée s'en sert avant toute authentification.
  route('GET', '/api/capabilities', (ctx) => ({ ...ctx.app.capabilities, version: ctx.app.info.version }), { public: true });
}
