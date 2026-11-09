// « Tout est normal » et « Tout marquer comme lu » retirent le rappel d'échéance de l'accueil.
// La date reste dans le détail du site. Une vraie alerte (piratage) n'est pas effacée.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startServer } from '../test-support/server.js';
import { openPage, findChrome } from '../test-support/browser.js';

const srv = await startServer({ env: { SURICATE_DEMO: '1' } });
const sql = new DatabaseSync(join(srv.dataDir, 'suricate.db'));
test.after(async () => { sql.close(); await srv.stop(); });

const DAY = 864e5;
const expiresIn = (days) => Date.now() + days * DAY;
const watch = async (name) => {
  const r = await srv.post('/api/watches', { url: `https://${name.toLowerCase().replace(/\s+/g, '-')}.example/`, name, enabled: true, config: { mode: 'domain' } });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const plant = (id, { severity = 'warning', title, extra = {}, alerts }) => {
  const expires = expiresIn(severity === 'critical' ? 5 : 21);
  const incident = { severity, title, detail: `exemple.example · échéance dans ${severity === 'critical' ? 5 : 21} j`, since: Date.now() - DAY };
  sql.prepare('UPDATE watches SET state = ?, last_check = ? WHERE id = ?').run(JSON.stringify({
    baseline: true,
    incidents: { rdap_expiring: incident, ...extra },
    rdap: { checkedAt: Date.now(), registrar: 'Gandi SAS', expires, status: ['client transfer prohibited'], nameservers: ['ns1.example'], locked: true, dnssec: true },
  }), Date.now(), id);
  const ins = sql.prepare('INSERT INTO alerts(watch_id, ts, severity, type, title, detail, read) VALUES(?,?,?,?,?,?,?)');
  for (const a of alerts) ins.run(id, Date.now(), a.severity, a.type, a.title, a.detail || '', a.read ? 1 : 0);
};
const byName = async (name) => (await srv.get('/api/watches')).json.find((w) => w.name === name);
const domainIncident = (w) => w.incidents.find((i) => i.key === 'rdap_expiring');

describe('rappel d\'échéance acquitté', { concurrency: 1 }, () => {
  test('Tout est normal et Tout marquer comme lu retirent l\'échéance de l\'accueil', async () => {
    const seul = await watch('Domaine seul');
    const pirate = await watch('Site pirate');
    plant(seul.id, {
      title: 'Le nom de domaine expire dans 21 jour(s)',
      alerts: [{ severity: 'warning', type: 'rdap_expiring', title: 'Le nom de domaine expire dans 21 jour(s)' }],
    });
    plant(pirate.id, {
      title: 'Le nom de domaine expire dans 21 jour(s)',
      extra: { forbidden: { severity: 'critical', title: 'Texte suspect détecté : « hacked by »', detail: '…', since: Date.now() - DAY } },
      alerts: [
        { severity: 'warning', type: 'rdap_expiring', title: 'Le nom de domaine expire dans 21 jour(s)' },
        { severity: 'critical', type: 'forbidden', title: 'Texte suspect détecté : « hacked by »' },
      ],
    });

    let row = await byName('Domaine seul');
    assert.equal(row.status, 'warning');
    assert.equal(domainIncident(row).acked, undefined, 'alerte non lue : visible sur l\'accueil');

    assert.equal((await srv.post(`/api/watches/${seul.id}/ack`)).status, 200);
    row = await byName('Domaine seul');
    assert.equal(row.status, 'ok', 'l\'accueil ne signale plus le renouvellement');
    assert.equal(domainIncident(row).acked, true);
    assert.ok(row.domainExpires > Date.now() + 20 * DAY, 'la date d\'échéance est conservée');

    const detail = await srv.get(`/api/watches/${seul.id}`);
    assert.equal(domainIncident(detail.json).title, 'Le nom de domaine expire dans 21 jour(s)');
    assert.equal(detail.json.signals.rdap.registrar, 'Gandi SAS');
    const domain = await srv.get(`/api/watches/${seul.id}/domain`);
    assert.ok(domain.json.incidents.some((i) => i.key === 'rdap_expiring'));
    assert.equal(domain.json.rdap.registrar, 'Gandi SAS');

    // Un jour de moins, même palier : reste acquitté.
    const state = JSON.parse(sql.prepare('SELECT state FROM watches WHERE id = ?').get(seul.id).state);
    state.incidents.rdap_expiring.title = 'Le nom de domaine expire dans 20 jour(s)';
    sql.prepare('UPDATE watches SET state = ? WHERE id = ?').run(JSON.stringify(state), seul.id);
    assert.equal((await byName('Domaine seul')).status, 'ok');

    // Passage sous 7 jours sans nouvelle alerte : l'accueil se rallume.
    state.incidents.rdap_expiring.severity = 'critical';
    state.incidents.rdap_expiring.title = 'Le nom de domaine expire dans 5 jour(s)';
    sql.prepare('UPDATE watches SET state = ? WHERE id = ?').run(JSON.stringify(state), seul.id);
    row = await byName('Domaine seul');
    assert.equal(row.status, 'critical');
    assert.equal(domainIncident(row).acked, undefined);

    let both = await byName('Site pirate');
    assert.equal(both.status, 'critical');
    assert.equal((await srv.post('/api/alerts/read', { all: true })).status, 200);
    both = await byName('Site pirate');
    assert.equal(both.status, 'critical', 'le piratage reste une alerte');
    assert.equal(domainIncident(both).acked, true, 'l\'échéance, elle, quitte l\'accueil');
    assert.ok(both.incidents.some((i) => i.key === 'forbidden' && !i.acked));
  });

  test('sans alerte non lue, le site reste « à vérifier » et Tout est normal le retire quand même', async () => {
    const w = await watch('Déjà consulté');
    plant(w.id, { title: 'Le nom de domaine expire dans 21 jour(s)', alerts: [] });
    let row = await byName('Déjà consulté');
    assert.equal(row.status, 'warning');
    assert.equal(row.unread.warning, 0, 'rien à marquer comme lu, donc pas de pastille');
    assert.equal(domainIncident(row).acked, undefined);

    assert.equal((await srv.post(`/api/watches/${w.id}/ack`)).status, 200);
    row = await byName('Déjà consulté');
    assert.equal(row.status, 'ok');
    assert.equal(domainIncident(row).acked, true);
    assert.ok(row.domainExpires > Date.now());
    const detail = await srv.get(`/api/watches/${w.id}/domain`);
    assert.equal(detail.json.rdap.registrar, 'Gandi SAS');
    assert.ok(detail.json.incidents.some((i) => i.key === 'rdap_expiring'));
  });

  test('interface : les deux boutons calment l\'accueil et laissent l\'échéance dans le détail', { skip: !findChrome() && 'Chrome/Chromium introuvable', timeout: 60000 }, async () => {
    const deja = await watch('Déjà lu');
    const domaine = await watch('Renouvellement');
    const pirate = await watch('Piratage');
    plant(deja.id, { title: 'Le nom de domaine expire dans 21 jour(s)', alerts: [] });
    plant(domaine.id, {
      title: 'Le nom de domaine expire dans 21 jour(s)',
      alerts: [{ severity: 'warning', type: 'rdap_expiring', title: 'Le nom de domaine expire dans 21 jour(s)' }],
    });
    plant(pirate.id, {
      title: 'Le nom de domaine expire dans 21 jour(s)',
      extra: { forbidden: { severity: 'critical', title: 'Texte suspect détecté : « hacked by »', detail: '…', since: Date.now() - DAY } },
      alerts: [
        { severity: 'warning', type: 'rdap_expiring', title: 'Le nom de domaine expire dans 21 jour(s)' },
        { severity: 'critical', type: 'forbidden', title: 'Texte suspect détecté : « hacked by »' },
      ],
    });

    const page = await openPage(`${srv.base}/`);
    const waitFor = (expr) => page.run(`new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { let v; try { v = (${expr}); } catch (e) { v = null; } if (v) { clearInterval(i); res(v); } else if (Date.now() - t0 > 8000) { clearInterval(i); rej(new Error(${JSON.stringify(expr)} + ' — ' + document.body.innerText.slice(0, 240))); } }, 80); })`);
    // Changer seulement le # ne recharge pas la page : la session posée ensuite ne serait pas prise en compte.
    const go = async (hash) => { await page.run(`location.hash = ${JSON.stringify(hash)}`); };
    try {
      const status = await page.run(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'motdepasse-test-1' }) }).then((r) => r.status)`);
      assert.equal(status, 200);
      await page.navigate(`${srv.base}/`);
      const rowState = (name) => `(() => { const row = [...document.querySelectorAll('.site')].find((r) => r.querySelector('.n')?.textContent === ${JSON.stringify(name)}); if (!row) return null; const chip = row.querySelector('.chip[title^="Nom de domaine"]'); return { issue: row.querySelector('.issue')?.textContent || '', pill: row.querySelector('.pill')?.textContent || '', chip: chip ? [...chip.classList] : [] }; })()`;

      const quiet = await waitFor(rowState('Déjà lu'));
      assert.match(quiet.pill, /vérifier/, 'échéance sans alerte non lue : le site reste à vérifier');
      await go(`#/sites/${deja.id}`);
      await waitFor(`document.body.innerText.includes('Tout est normal')`);
      await page.run(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Tout est normal')).click()`);
      await waitFor(`! [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Tout est normal'))`);
      await go('#/');
      const cleared = await waitFor(rowState('Déjà lu'));
      assert.equal(cleared.issue, '');
      assert.match(cleared.pill, /Intact/);

      const before = await waitFor(rowState('Renouvellement'));
      assert.match(before.issue, /expire/);
      assert.match(before.pill, /vérifier/);
      assert.ok(before.chip.includes('warn'), before.chip.join(' '));

      await go(`#/sites/${domaine.id}`);
      await waitFor(`document.body.innerText.includes('Tout est normal')`);
      await page.run(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Tout est normal')).click()`);
      await waitFor(`! [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Tout est normal')) && document.body.innerText.includes('expire')`);

      await go('#/');
      const after = await waitFor(rowState('Renouvellement'));
      assert.equal(after.issue, '', 'plus d\'alerte sur l\'accueil');
      assert.match(after.pill, /Intact/);
      assert.ok(!after.chip.includes('warn') && !after.chip.includes('crit'), after.chip.join(' '));
      const hack = await waitFor(rowState('Piratage'));
      assert.match(hack.issue, /hacked by/);

      await go(`#/sites/${domaine.id}/domaine`);
      const kept = await waitFor(`document.body.innerText.includes('Échéance') && document.body.innerText.includes('Gandi')`);
      assert.equal(kept, true);

      await go('#/alertes');
      await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Tout marquer comme lu') && !b.disabled)`);
      await page.run(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Tout marquer comme lu')).click()`);
      await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Tout marquer comme lu') && b.disabled)`);

      await go('#/');
      const still = await waitFor(rowState('Piratage'));
      assert.match(still.issue, /hacked by/, 'le piratage reste affiché');
      assert.ok(!still.chip.includes('warn') && !still.chip.includes('crit'), 'l\'échéance ne colore plus l\'accueil');
    } finally {
      await page.close();
    }
  });
});
