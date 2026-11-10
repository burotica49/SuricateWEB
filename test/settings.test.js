import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Une base « d'une ancienne version » : réglages enregistrés avant les migrations successives.
const dir = mkdtempSync(join(tmpdir(), 'suricate-settings-'));
process.env.DATA_DIR = dir;
{
  const old = new DatabaseSync(join(dir, 'suricate.db'));
  old.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  old.prepare("INSERT INTO settings VALUES('app', ?)").run(JSON.stringify({
    sessionSecret: 'secret-existant',
    passwordHash: 's1$00$11', // ancien mot de passe stocké en base (avant le .env)
    userAgent: ['Mozilla/5.0 (compatible; ', 'Vigie', '/1.0; surveillance de site)'].join(''), // ancien défaut
    builtinKeywords: ['hacked by', 'owned by', 'was here', 'cialis', 'mon-mot-perso'],
    retention: { checks: 3000, snapshots: 300 },
    telegram: { token: '123:ABC', chatId: '42' },
  }));
  old.close();
}

const dbm = await import('../src/db.js');

test('migration des réglages d\'une ancienne base (v2 → v7)', async () => {
  const s = dbm.getSettings();
  assert.equal(s.settingsVersion, 7);
  assert.deepEqual(s.builtinKeywords, ['hacked by', 'cialis', 'mon-mot-perso'], 'v2 : expressions ambiguës retirées, mots personnalisés conservés');
  assert.equal(s.retention.checks, 10000, 'v3 : rétention des contrôles relevée');
  assert.equal('passwordHash' in s, false, 'v4 : l\'ancien hash est effacé');
  assert.equal(s.userAgent, 'Mozilla/5.0 (compatible; SuricateWeb/1.0; surveillance de site)', 'v5 puis v7 : User-Agent par défaut aligné sur le nom actuel du produit');
  assert.equal(s.sessionSecret, 'secret-existant', 'le secret de session (donc les connexions ouvertes) est conservé');
  assert.deepEqual([s.telegram.token, s.telegram.chatId], ['123:ABC', '42'], 'la configuration Telegram est conservée');
  assert.equal(s.telegram.sendScreenshot, true, 'nouvelles options : valeur par défaut');
  const stored = JSON.parse((await dbm.db.get("SELECT value FROM settings WHERE key = 'app'")).value);
  assert.equal(stored.settingsVersion, 7, 'la migration est persistée : elle ne rejoue pas');
  // v6 : les réglages du compte implicite quittent la ligne de l'installation pour « account:1 »
  assert.deepEqual(Object.keys(stored).sort(), ['baseUrl', 'retention', 'sessionSecret', 'settingsVersion'], 'la ligne de l\'installation ne garde que ce qui la concerne');
  assert.deepEqual(stored.retention, { checks: 10000, snapshots: 300 });
  const account = JSON.parse((await dbm.db.get("SELECT value FROM settings WHERE key = 'account:1'")).value);
  assert.deepEqual([account.telegram.token, account.telegram.chatId], ['123:ABC', '42']);
  assert.deepEqual(account.builtinKeywords, ['hacked by', 'cialis', 'mon-mot-perso']);
  assert.deepEqual(account.retention, { screenshots: 168 });
  assert.equal(account.sessionSecret, undefined, 'le secret de session reste propre à l\'installation');
});

test('deux niveaux : l\'écriture d\'un compte ne touche ni l\'installation ni un autre compte ; la vue fusionnée réunit les deux', async () => {
  const before = dbm.getInstanceSettings();
  await dbm.saveAccountSettings(7, { telegram: { token: 'compte-7', chatId: '7' }, defaultInterval: 30, retention: { screenshots: 12 } });
  const s7 = await dbm.settingsFor(7);
  assert.deepEqual([s7.telegram.token, s7.defaultInterval, s7.retention.screenshots], ['compte-7', 30, 12]);
  assert.equal(s7.telegram.sendRecovery, true, 'les champs non écrits gardent leur valeur par défaut');
  assert.equal(s7.sessionSecret, before.sessionSecret, 'la vue fusionnée porte aussi les réglages de l\'installation');
  assert.equal(s7.retention.checks, 10000, '…y compris la rétention des contrôles, qui est propre à l\'installation');
  // un autre compte (sans ligne) : valeurs par défaut ; le compte implicite : inchangé
  const s8 = await dbm.settingsFor(8);
  assert.deepEqual([s8.telegram.token, s8.defaultInterval, s8.retention.screenshots], ['', 15, 168]);
  assert.equal(dbm.getSettings().telegram.token, '123:ABC');
  assert.deepEqual(dbm.getInstanceSettings(), before, 'l\'installation n\'a pas bougé');
  // l'installation : seulement via saveInstanceSettings
  await dbm.saveInstanceSettings({ baseUrl: 'https://suricate.example' });
  assert.equal((await dbm.settingsFor(7)).baseUrl, 'https://suricate.example');
  assert.equal((await dbm.settingsFor(8)).baseUrl, 'https://suricate.example', 'adresse publique : commune à tous les comptes');
  // l'ancienne écriture répartit les champs entre les deux niveaux
  await dbm.saveSettings({ baseUrl: '', retention: { checks: 5000, screenshots: 99 }, cmsAfterDays: 3 });
  assert.deepEqual([dbm.getInstanceSettings().baseUrl, dbm.getInstanceSettings().retention], ['', { checks: 5000, snapshots: 300 }]);
  const core = await dbm.settingsFor(1);
  assert.deepEqual([core.retention.screenshots, core.cmsAfterDays], [99, 3]);
  assert.equal((await dbm.settingsFor(7)).cmsAfterDays, 7, 'sans effet sur les autres comptes');
});

test('un User-Agent personnalisé n\'est jamais modifié par la migration', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'suricate-settings2-'));
  const db2 = new DatabaseSync(join(d2, 'suricate.db'));
  db2.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db2.prepare("INSERT INTO settings VALUES('app', ?)").run(JSON.stringify({ sessionSecret: 'x', settingsVersion: 4, userAgent: 'Mon-Agent-Maison/2.0 (WAF autorisé)' }));
  db2.close();
  // Même logique, sur une base isolée : on rejoue la migration via un module neuf.
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
    "const m = await import(process.argv[1]); console.log(JSON.stringify(m.getSettings().userAgent)); process.exit(0);",
    new URL('../src/db.js', import.meta.url).href], { env: { ...process.env, DATA_DIR: d2 } }).toString().trim();
  assert.equal(JSON.parse(out), 'Mon-Agent-Maison/2.0 (WAF autorisé)');
});

test('v7 : le User-Agent par défaut de l\'ancien nom suit le renommage, un User-Agent personnalisé reste intact', async () => {
  const { execFileSync } = await import('node:child_process');
  const oldDefault = ['Mozilla/5.0 (compatible; ', 'Vigie', 'Web/1.0; surveillance de site)'].join('');
  // Deux bases déjà en version 6 : l'une garde l'ancien défaut, l'autre un User-Agent choisi par l'utilisateur.
  const read = (userAgent) => {
    const d = mkdtempSync(join(tmpdir(), 'suricate-settings-v7-'));
    const raw = new DatabaseSync(join(d, 'suricate.db'));
    raw.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    raw.prepare("INSERT INTO settings VALUES('app', ?)").run(JSON.stringify({ sessionSecret: 'x', settingsVersion: 6 }));
    raw.prepare("INSERT INTO settings VALUES('account:1', ?)").run(JSON.stringify({ userAgent }));
    raw.close();
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
      "const m = await import(process.argv[1]); console.log(JSON.stringify(m.getSettings().userAgent)); process.exit(0);",
      new URL('../src/db.js', import.meta.url).href], { env: { ...process.env, DATA_DIR: d } }).toString().trim();
    return JSON.parse(out);
  };
  assert.equal(read(oldDefault), 'Mozilla/5.0 (compatible; SuricateWeb/1.0; surveillance de site)');
  assert.equal(read('Mon-Agent-Maison/2.0 (WAF autorisé)'), 'Mon-Agent-Maison/2.0 (WAF autorisé)');
});

test.after(() => dbm.db.close());

test('SCREENSHOT_KEEP_DEFAULT : défaut de conservation des captures (168 sans la variable), borné, sans effet sur ce qu\'un compte a choisi', async () => {
  const keep = () => dbm.accountDefaults().retention.screenshots;
  const before = process.env.SCREENSHOT_KEEP_DEFAULT;
  try {
    delete process.env.SCREENSHOT_KEEP_DEFAULT;
    assert.equal(keep(), 168);
    process.env.SCREENSHOT_KEEP_DEFAULT = '24';
    assert.equal(keep(), 24);
    for (const bad of ['0', '-5', 'abc', '', '999999']) { process.env.SCREENSHOT_KEEP_DEFAULT = bad; assert.equal(keep(), 168, `valeur absurde « ${bad} » : défaut habituel`); }
  } finally {
    if (before === undefined) delete process.env.SCREENSHOT_KEEP_DEFAULT; else process.env.SCREENSHOT_KEEP_DEFAULT = before;
  }
});

test('SCREENSHOT_KEEP_DEFAULT défini AU CHARGEMENT du module (cas de l\'image hébergée) : le cœur démarre et applique le défaut', async () => {
  // Régression : une constante lue avant sa déclaration faisait planter le démarrage dès que la variable était définie (ReferenceError).
  const { spawnSync } = await import('node:child_process');
  const out = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
    "const db = await import('./src/db.js'); console.log('KEEP=' + (await db.settingsFor(1)).retention.screenshots); db.db.close();"],
  { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), 'suricate-keep-')), SCREENSHOT_KEEP_DEFAULT: '24' }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /KEEP=24/);
});
