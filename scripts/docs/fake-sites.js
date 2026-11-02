// Faux sites web pour la documentation : des pages HTML crédibles, servies localement, que VigieWeb « capture » dans la démo.
// Tous les noms de domaine utilisent le TLD réservé « .example » (RFC 2606) : ils ne désignent aucun vrai site.
import http from 'node:http';

export const SITES = {
  dupont: {
    name: 'Fromagerie Dupont', domain: 'www.fromagerie-dupont.example', accent: '#d97706', accent2: '#92400e', bg: '#fffbeb', ink: '#451a03',
    nav: ['Accueil', 'Nos fromages', 'Boutique', 'Notre histoire', 'Contact'],
    hero: { title: 'Fromages affinés à la main depuis 1987', text: 'Au cœur de la Bourgogne, la famille Dupont sélectionne et affine ses fromages avec passion.', cta: 'Découvrir la boutique' },
    cards: [{ t: 'Époisses affiné', d: 'Au marc de Bourgogne, crémeux et puissant.' }, { t: 'Comté 24 mois', d: 'Fruité et long en bouche, de nos fruitières partenaires.' }, { t: 'Chèvre fermier', d: 'De la Côte-d\'Or, frais ou demi-sec.' }],
    footer: '12 rue des Halles, 21000 Dijon · 03 80 00 00 00 · Mentions légales',
    promo: 'Plateau de Noël : -15 % jusqu\'au 24 décembre',
  },
  martin: {
    name: 'Cabinet Martin', domain: 'www.cabinet-martin.example', accent: '#2563eb', accent2: '#1e3a8a', bg: '#f1f5f9', ink: '#0f172a',
    nav: ['Le cabinet', 'Nos missions', 'Actualités', 'Espace client', 'Contact'],
    hero: { title: 'Experts-comptables à vos côtés', text: 'Comptabilité, paie, conseil et accompagnement des TPE et PME de l\'ouest depuis 25 ans.', cta: 'Prendre rendez-vous' },
    cards: [{ t: 'Comptabilité', d: 'Bilans, déclarations fiscales et tableaux de bord.' }, { t: 'Paie et social', d: 'Bulletins, déclarations et conseil en droit social.' }, { t: 'Création d\'entreprise', d: 'Statut, business plan et formalités.' }],
    footer: '4 place de la Mairie, 49300 Cholet · 02 41 00 00 00 · Mentions légales',
  },
  leroy: {
    name: 'Garage Leroy', domain: 'www.garage-leroy.example', accent: '#dc2626', accent2: '#111827', bg: '#f3f4f6', ink: '#111827',
    nav: ['Accueil', 'Entretien', 'Pneumatiques', 'Véhicules d\'occasion', 'Contact'],
    hero: { title: 'Votre voiture entre de bonnes mains', text: 'Entretien toutes marques, contrôle technique et dépannage 7j/7 à Angers.', cta: 'Réserver un créneau' },
    cards: [{ t: 'Révision', d: 'Constructeur ou multimarque, devis gratuit.' }, { t: 'Pneumatiques', d: 'Montage, équilibrage et géométrie.' }, { t: 'Occasions', d: 'Véhicules contrôlés et garantis 12 mois.' }],
    footer: '27 boulevard Foch, 49000 Angers · 02 41 11 11 11 · Mentions légales',
  },
  nova: {
    name: 'Nova Boutique', domain: 'www.nova-boutique.example', accent: '#9333ea', accent2: '#581c87', bg: '#faf5ff', ink: '#3b0764',
    nav: ['Nouveautés', 'Femme', 'Homme', 'Maison', 'Soldes'],
    hero: { title: 'La collection d\'automne est arrivée', text: 'Des pièces durables, fabriquées en Europe. Livraison offerte dès 60 € d\'achat.', cta: 'Voir la collection' },
    cards: [{ t: 'Manteau en laine', d: '149 €  ·  4 coloris' }, { t: 'Pull en maille', d: '79 €  ·  6 coloris' }, { t: 'Sac cabas cuir', d: '119 €  ·  3 coloris' }],
    footer: 'Livraison 48 h · Retours gratuits 30 jours · Mentions légales',
  },
  lumiere: {
    name: 'Maison Lumière', domain: 'www.maison-lumiere.example', accent: '#0d9488', accent2: '#134e4a', bg: '#f0fdfa', ink: '#042f2e',
    nav: ['Luminaires', 'Lampes', 'Suspensions', 'Conseils', 'Contact'],
    hero: { title: 'La lumière qui fait la maison', text: 'Luminaires design et ampoules LED, sélectionnés par nos conseillers éclairage.', cta: 'Explorer le catalogue' },
    cards: [{ t: 'Suspensions', d: 'Verre soufflé, laiton, rotin.' }, { t: 'Lampes de table', d: 'Pour le salon, le bureau, la chambre.' }, { t: 'Éclairage LED', d: 'Économique et durable.' }],
    footer: '8 rue des Lumières, 44000 Nantes · 02 40 22 22 22 · Mentions légales',
  },
  intranet: {
    name: 'Intranet équipe', domain: 'intranet.exemple-societe.example', accent: '#4f46e5', accent2: '#312e81', bg: '#eef2ff', ink: '#1e1b4b',
    nav: ['Accueil', 'Annuaire', 'Documents', 'Congés', 'Support'],
    hero: { title: 'Bonjour, bienvenue sur l\'intranet', text: 'Retrouvez les actualités de l\'entreprise, vos documents partagés et vos demandes en cours.', cta: 'Mes demandes' },
    cards: [{ t: 'Actualités', d: 'Nouveau process de facturation dès lundi.' }, { t: 'Documents', d: '12 documents mis à jour cette semaine.' }, { t: 'Congés', d: 'Posez vos congés d\'hiver avant le 15.' }],
    footer: 'Accès réservé aux collaborateurs · Support : poste 4242',
  },
  wiki: {
    name: 'Wiki technique', domain: 'wiki.exemple-societe.example', accent: '#475569', accent2: '#0f172a', bg: '#f8fafc', ink: '#0f172a',
    nav: ['Accueil', 'Procédures', 'Réseau', 'Sauvegardes', 'Contacts'],
    hero: { title: 'Base de connaissances technique', text: 'Procédures d\'installation, schémas réseau et fiches de dépannage de l\'équipe.', cta: 'Parcourir les procédures' },
    cards: [{ t: 'Réseau', d: 'Plan d\'adressage, VLAN, pare-feu.' }, { t: 'Sauvegardes', d: 'Plan de sauvegarde et tests de restauration.' }, { t: 'Postes de travail', d: 'Images, déploiement, inventaire.' }],
    footer: 'Dernière mise à jour : cette semaine · Équipe infrastructure',
  },
};

/** Lignes de texte visibles d'une page : sert aussi à fabriquer les versions enregistrées (onglet Modifications). */
export const linesOf = (s, { promo = false } = {}) => [
  s.name, s.nav.join(' '), s.hero.title, s.hero.text, s.hero.cta,
  ...(promo && s.promo ? [s.promo] : []),
  ...s.cards.flatMap((c) => [c.t, c.d]), s.footer,
];

/** Texte de la page défigurée de la fromagerie : ce que voient les visiteurs après le piratage. */
export const DEFACED_LINES = ['Hacked by Anonymous Cyber Team', 'Your security is a joke. greetz to all.', 'We were here. You were not paying attention.'];

export function siteHtml(slug, { promo = false } = {}) {
  const s = SITES[slug];
  const card = (c) => `<div class="card"><i></i><h3>${c.t}</h3><p>${c.d}</p></div>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${s.name}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font:16px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:${s.ink};background:${s.bg};min-height:800px}
header{display:flex;align-items:center;justify-content:space-between;padding:20px 64px;background:#fff;border-bottom:1px solid rgba(0,0,0,.07)}
.brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:22px;color:${s.accent2}}
.logo{width:34px;height:34px;border-radius:10px;background:${s.accent}}
nav{display:flex;gap:28px;font-size:15px;color:#475569}nav b{color:${s.accent2}}
.promo{background:${s.accent2};color:#fff;text-align:center;padding:9px;font-size:14px;font-weight:600}
.hero{display:grid;grid-template-columns:1.1fr .9fr;gap:48px;padding:56px 64px 48px;align-items:center}
h1{font-size:46px;line-height:1.1;letter-spacing:-.02em}
.hero p{margin:18px 0 28px;font-size:18px;color:#475569;max-width:520px}
.cta{display:inline-block;padding:14px 26px;border-radius:12px;background:${s.accent};color:#fff;font-weight:700}
.art{height:290px;border-radius:28px;background:linear-gradient(135deg,${s.accent},${s.accent2});position:relative;overflow:hidden}
.art::before,.art::after{content:"";position:absolute;border-radius:50%;background:rgba(255,255,255,.16)}
.art::before{width:230px;height:230px;right:-50px;top:-60px}.art::after{width:150px;height:150px;left:34px;bottom:-40px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:0 64px}
.card{background:#fff;border-radius:18px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card i{display:block;width:40px;height:40px;border-radius:12px;background:${s.accent};opacity:.18;margin-bottom:14px}
.card h3{font-size:18px;margin-bottom:6px}.card p{font-size:14.5px;color:#64748b}
footer{margin-top:44px;padding:20px 64px;color:#64748b;font-size:14px;border-top:1px solid rgba(0,0,0,.07)}
</style></head><body>
${promo && s.promo ? `<div class="promo">${s.promo}</div>` : ''}
<header><div class="brand"><div class="logo"></div>${s.name}</div><nav><b>${s.nav[0]}</b>${s.nav.slice(1).map((n) => `<span>${n}</span>`).join('')}</nav></header>
<section class="hero"><div><h1>${s.hero.title}</h1><p>${s.hero.text}</p><span class="cta">${s.hero.cta}</span></div><div class="art"></div></section>
<section class="cards">${s.cards.map(card).join('')}</section>
<footer>${s.footer}</footer></body></html>`;
}

export const defacedHtml = () => `<!doctype html><html><head><meta charset="utf-8"><title>HACKED</title></head>
<body style="margin:0;background:#050505;color:#00ff41;font-family:'Courier New',monospace;text-align:center;min-height:800px">
<div style="padding-top:210px"><h1 style="font-size:56px;letter-spacing:3px;text-shadow:0 0 16px #00ff41">${DEFACED_LINES[0]}</h1>
<p style="font-size:24px;margin-top:34px">${DEFACED_LINES[1]}</p>
<p style="margin-top:80px;color:#ff0040;font-size:19px">${DEFACED_LINES[2]}</p></div></body></html>`;

/** Serveur local : /dupont, /martin… (pages normales), /dupont?defaced=1, et des pages libres ajoutées avec setPage(). */
export async function startFakeSites() {
  const pages = new Map();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const slug = u.pathname.slice(1);
    let html = pages.get(u.pathname);
    if (!html && SITES[slug]) html = u.searchParams.get('defaced') ? defacedHtml() : siteHtml(slug, { promo: u.searchParams.get('promo') === '1' });
    if (!html) { res.writeHead(404); return res.end('introuvable'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    port, base: `http://127.0.0.1:${port}`,
    setPage: (path, html) => pages.set(path, html),
    close: () => new Promise((r) => server.close(r)),
  };
}
