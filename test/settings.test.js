import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Une base « d'une ancienne version » : réglages enregistrés avant les migrations successives.
const dir = mkdtempSync(join(tmpdir(), 'vigie-settings-'));
process.env.DATA_DIR = dir;
{
  const old = new DatabaseSync(join(dir, 'vigie.db'));
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

test('migration des réglages d\'une ancienne base (v2 → v6)', async () => {
  const s = dbm.getSettings();
  assert.equal(s.settingsVersion, 6);
  assert.deepEqual(s.builtinKeywords, ['hacked by', 'cialis', 'mon-mot-perso'], 'v2 : expressions ambiguës retirées, mots personnalisés conservés');
  assert.equal(s.retention.checks, 10000, 'v3 : rétention des contrôles relevée');
  assert.equal('passwordHash' in s, false, 'v4 : l\'ancien hash est effacé');
  assert.equal(s.userAgent, 'Mozilla/5.0 (compatible; VigieWeb/1.0; surveillance de site)', 'v5 : User-Agent par défaut renommé');
  assert.equal(s.sessionSecret, 'secret-existant', 'le secret de session (donc les connexions ouvertes) est conservé');
  assert.deepEqual([s.telegram.token, s.telegram.chatId], ['123:ABC', '42'], 'la configuration Telegram est conservée');
  assert.equal(s.telegram.sendScreenshot, true, 'nouvelles options : valeur par défaut');
  const stored = JSON.parse((await dbm.db.get("SELECT value FROM settings WHERE key = 'app'")).value);
  assert.equal(stored.settingsVersion, 6, 'la migration est persistée : elle ne rejoue pas');
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
  await dbm.saveInstanceSettings({ baseUrl: 'https://vigie.example' });
  assert.equal((await dbm.settingsFor(7)).baseUrl, 'https://vigie.example');
  assert.equal((await dbm.settingsFor(8)).baseUrl, 'https://vigie.example', 'adresse publique : commune à tous les comptes');
  // l'ancienne écriture répartit les champs entre les deux niveaux
  await dbm.saveSettings({ baseUrl: '', retention: { checks: 5000, screenshots: 99 }, cmsAfterDays: 3 });
  assert.deepEqual([dbm.getInstanceSettings().baseUrl, dbm.getInstanceSettings().retention], ['', { checks: 5000, snapshots: 300 }]);
  const core = await dbm.settingsFor(1);
  assert.deepEqual([core.retention.screenshots, core.cmsAfterDays], [99, 3]);
  assert.equal((await dbm.settingsFor(7)).cmsAfterDays, 7, 'sans effet sur les autres comptes');
});

test('un User-Agent personnalisé n\'est jamais modifié par la migration', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'vigie-settings2-'));
  const db2 = new DatabaseSync(join(d2, 'vigie.db'));
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

test.after(() => dbm.db.close());
