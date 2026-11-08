import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../test-support/server.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'vigie-tgbtn-'));

// ── Faux Telegram : envoi, interrogation longue, réponses aux clics ──
const fake = { sent: [], answers: [], edits: [], polls: [], queue: [], rejectUrl: false, rejectMarkup: false, chatNotFound: false, getUpdatesStatus: null };
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', async () => {
    const body = b ? JSON.parse(b) : {};
    const method = req.url.split('/').pop();
    const token = decodeURIComponent(req.url.split('/')[1] || '').replace(/^bot/, '');
    const ok = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
    const fail = (status, description) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, description })); };
    if (method === 'sendMessage') {
      fake.sent.push(body);
      const markup = JSON.stringify(body.reply_markup || {});
      if (fake.chatNotFound) return fail(400, 'Bad Request: chat not found');
      if (fake.rejectMarkup && body.reply_markup) return fail(400, 'Bad Request: can\'t parse reply keyboard markup JSON object');
      if (fake.rejectUrl && markup.includes('"url"')) return fail(400, 'Bad Request: wrong HTTP URL: http://x/');
      return ok({ message_id: fake.sent.length });
    }
    if (method === 'getUpdates') {
      fake.polls.push({ ...body, token });
      if (fake.getUpdatesStatus && (!fake.getUpdatesStatus[2] || fake.getUpdatesStatus[2] === token)) { const [st, d] = fake.getUpdatesStatus; fake.getUpdatesStatus = fake.once ? null : fake.getUpdatesStatus; return fail(st, d); }
      // Confirmation : tout ce qui précède `offset` est oublié, comme chez Telegram.
      if (body.offset) fake.queue = fake.queue.filter((u) => u.update_id >= body.offset);
      const t0 = Date.now();
      while (!fake.queue.length && Date.now() - t0 < 150 && !res.destroyed) await new Promise((r) => setTimeout(r, 20));
      if (res.destroyed) return;
      return ok([...fake.queue]);
    }
    if (method === 'answerCallbackQuery') { fake.answers.push(body); return ok(true); }
    if (method === 'editMessageReplyMarkup') { fake.edits.push(body); return ok(true); }
    if (method === 'getMe') return ok({ username: 'vigie_bot' });
    return ok({});
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.TELEGRAM_API = `http://127.0.0.1:${server.address().port}`;

const tg = await import('../src/telegram.js');
const { startTelegramPoller, parseCallback, readKeyboard } = await import('../src/telegram-poll.js');
const dbm = await import('../src/db.js');

const reset = () => Object.assign(fake, { sent: [], answers: [], edits: [], polls: [], queue: [], rejectUrl: false, rejectMarkup: false, chatNotFound: false, getUpdatesStatus: null, once: false });
const pollsOf = (tok) => fake.polls.filter((p) => p.token === tok);
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('délai dépassé'); await new Promise((r) => setTimeout(r, 15)); } };
const watch = { id: 5, name: 'Boutique', url: 'https://boutique.example/' };
const alert = (id, severity = 'warning') => ({ id, severity, type: 'content_changed', title: 'Le contenu a changé', detail: '' });
const settings = (over = {}, tgOver = {}) => ({ baseUrl: 'https://vigieweb.exemple-societe.com', telegram: { includeDiff: true, buttons: true, ...tgOver }, ...over });
const buttons = (m) => (m.reply_markup?.inline_keyboard ?? [[]])[0];

test('adresse du bouton : publique seulement, jamais localhost ni réseau privé', () => {
  assert.equal(tg.siteLink('https://vigieweb.exemple.com', 7), 'https://vigieweb.exemple.com/#/sites/7');
  assert.equal(tg.siteLink('https://exemple.com/outils/vigieweb/', 7), 'https://exemple.com/outils/vigieweb/#/sites/7', 'installation dans un sous-dossier');
  assert.equal(tg.siteLink('http://vigieweb.exemple.com:8080', 7), 'http://vigieweb.exemple.com:8080/#/sites/7');
  for (const bad of ['', null, 'ftp://x.com', 'vigieweb.exemple.com', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://192.168.1.20', 'http://10.0.0.4', 'http://172.20.1.1', 'http://nas.local', 'http://vigieweb', 'http://[::1]:3000', 'javascript:alert(1)']) {
    assert.equal(tg.siteLink(bad, 7), null, `refusé : ${bad}`);
  }
});

test('clavier : « Marquer comme lu » + « Ouvrir », sans doublon du lien dans le texte', () => {
  const kb = tg.buildKeyboard(watch, [alert(10), alert(12, 'critical'), alert(11)], settings());
  assert.deepEqual(kb.row.map((b) => b.text), ['✓ Marquer comme lu', 'Ouvrir dans VigieWeb']);
  assert.equal(kb.row[0].callback_data, 'lu:5:12', 'jusqu’à la plus récente alerte du message');
  assert.ok(Buffer.byteLength(kb.row[0].callback_data) <= 64);
  assert.equal(kb.row[1].url, 'https://vigieweb.exemple-societe.com/#/sites/5');
  assert.equal(kb.link, true);
  assert.doesNotMatch(tg.buildMessage(watch, [alert(10)], settings(), { link: !kb.link }), /Ouvrir dans VigieWeb/);
  assert.match(tg.buildMessage(watch, [alert(10)], settings()), /Ouvrir dans VigieWeb/, 'comportement historique conservé sans boutons');

  assert.deepEqual(parseCallback(kb.row[0].callback_data), { watchId: 5, upTo: 12 });
  assert.deepEqual(readKeyboard([kb.row]), [[{ text: '✓ Lu', callback_data: 'ok' }, kb.row[1]]], 'le bouton de lecture devient « ✓ Lu », l’autre reste');
});

test('clavier : adresse locale = bouton de lecture seul ; rétablissement = lien seul ; boutons coupés = rien', () => {
  const local = tg.buildKeyboard(watch, [alert(10)], settings({ baseUrl: 'http://localhost:3000' }));
  assert.deepEqual(local.row.map((b) => b.text), ['✓ Marquer comme lu']);
  assert.equal(local.link, false, 'le lien reste dans le texte');
  const recovery = tg.buildKeyboard(watch, [alert(10, 'recovery')], settings());
  assert.deepEqual(recovery.row.map((b) => b.text), ['Ouvrir dans VigieWeb'], 'un « rétabli » est déjà lu');
  assert.deepEqual(tg.buildKeyboard(watch, [alert(10)], settings({}, { buttons: false })), { row: [], link: false });
  assert.deepEqual(tg.buildKeyboard(watch, [{ severity: 'warning' }], settings({ baseUrl: '' })).row, [], 'alerte sans identifiant : rien à marquer');
});

test('envoi : boutons joints ; repli sans bouton lien, puis sans bouton, si Telegram refuse', async () => {
  reset();
  await tg.sendAlert('123:ABC', '42', watch, [alert(10)], settings());
  assert.deepEqual(buttons(fake.sent[0]).map((b) => b.text), ['✓ Marquer comme lu', 'Ouvrir dans VigieWeb']);
  assert.doesNotMatch(fake.sent[0].text, /Ouvrir dans VigieWeb/);

  reset();
  fake.rejectUrl = true;
  await tg.sendAlert('123:ABC', '42', watch, [alert(10)], settings());
  assert.equal(fake.sent.length, 2, 'un 2e essai');
  assert.deepEqual(buttons(fake.sent[1]).map((b) => b.text), ['✓ Marquer comme lu'], 'sans le bouton lien');
  assert.match(fake.sent[1].text, /Ouvrir dans VigieWeb/, 'le lien revient dans le texte');

  reset();
  fake.rejectMarkup = true;
  await tg.sendAlert('123:ABC', '42', watch, [alert(10)], settings());
  assert.equal(fake.sent.length, 3, 'complet, puis sans bouton lien, puis sans aucun bouton');
  assert.equal(fake.sent[2].reply_markup, undefined, 'retour au message simple : l’alerte part quand même');
  assert.match(fake.sent[2].text, /Ouvrir dans VigieWeb/);

  reset();
  fake.chatNotFound = true;
  await assert.rejects(tg.sendAlert('123:ABC', '42', watch, [alert(10)], settings()), /Conversation introuvable/);
  assert.equal(fake.sent.length, 1, 'une autre erreur n’est pas rejouée');

  reset();
  await tg.sendAlert('123:ABC', '42', watch, [alert(10)], settings({}, { buttons: false }));
  assert.equal(fake.sent[0].reply_markup, undefined, 'boutons désactivés : message identique à avant');
});

test('base : marquer comme lu jusqu’à une alerte, pour un seul site', async () => {
  const a = await dbm.createWatch({ name: 'A', url: 'http://a.example/', interval: 5 });
  const b = await dbm.createWatch({ name: 'B', url: 'http://b.example/', interval: 5 });
  const ids = [];
  for (const i of [1, 2, 3]) ids.push(await dbm.insertAlert({ watchId: a.id, severity: 'warning', type: i === 2 ? 'rdap_expiring' : 'content_changed', title: `a${i}` }));
  const other = await dbm.insertAlert({ watchId: b.id, severity: 'warning', type: 'content_changed', title: 'b1' });
  const rows = await dbm.markAlertsReadUpTo(a.id, ids[1]);
  assert.deepEqual(rows.map((r) => r.id), [ids[0], ids[1]], 'jusqu’à l’alerte indiquée, pas au-delà');
  assert.ok(rows.some((r) => r.type === 'rdap_expiring'));
  const read = async (id) => (await dbm.db.get('SELECT read FROM alerts WHERE id = ?', [id])).read;
  assert.deepEqual(await Promise.all([ids[0], ids[1], ids[2], other].map(read)), [1, 1, 0, 0]);
  assert.deepEqual(await dbm.markAlertsReadUpTo(a.id, ids[1]), [], 'déjà lues : rien');
  assert.deepEqual(await dbm.markAlertsReadUpTo(99999, 5), []);
});

const click = (data, over = {}) => ({ update_id: over.update_id ?? 10, callback_query: { id: `cq${over.update_id ?? 10}`, data, message: { message_id: 7, chat: { id: over.chat ?? 42 }, reply_markup: { inline_keyboard: [[{ text: '✓ Marquer comme lu', callback_data: 'lu:5:42' }, { text: 'Ouvrir', url: 'https://x.example/' }]] } } } });

test('clics : marque comme lu, répond, remplace le bouton, ne rejoue jamais un clic', async () => {
  reset();
  const read = [];
  const poller = startTelegramPoller({ settings: () => ({ token: 'T1:CLICK', chatId: '42', enabled: true, buttons: true }), onRead: (w, u) => { read.push([w, u]); return 3; }, pollSeconds: 0, idleMs: 20, log: { warn() {}, error() {} } });
  try {
    fake.queue = [click('lu:5:42')];
    await until(() => fake.edits.length === 1);
    assert.deepEqual(read, [[5, 42]]);
    assert.equal(fake.answers[0].text, '3 alertes marquées comme lues.');
    assert.equal(fake.answers[0].callback_query_id, 'cq10');
    assert.deepEqual(fake.edits[0].reply_markup.inline_keyboard, [[{ text: '✓ Lu', callback_data: 'ok' }, { text: 'Ouvrir', url: 'https://x.example/' }]]);
    assert.equal(fake.edits[0].message_id, 7);
    await until(() => pollsOf('T1:CLICK').some((p) => p.offset === 11));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(read.length, 1, 'confirmé (offset 11) : le clic n’est pas rejoué');
    assert.deepEqual(pollsOf('T1:CLICK')[0].allowed_updates, ['callback_query'], 'seuls les clics sont demandés');
  } finally { poller.stop(); }
});

test('clics : conversation inconnue, bouton déjà lu, bouton périmé, échec — chacun reçoit une réponse', async () => {
  reset();
  const calls = [];
  let mode = 'one';
  const poller = startTelegramPoller({ settings: () => ({ token: 'T2:CASES', chatId: '42', enabled: true, buttons: true }), onRead: (w, u) => { calls.push([w, u]); if (mode === 'boom') throw new Error('base fermée'); return mode === 'zero' ? 0 : 1; }, pollSeconds: 0, idleMs: 20, log: { warn() {}, error() {} } });
  try {
    fake.queue = [click('lu:5:42', { update_id: 20, chat: 99 })];
    await until(() => fake.answers.length === 1);
    assert.equal(calls.length, 0, 'une autre conversation n’a aucun pouvoir');
    assert.deepEqual([fake.answers[0].text, fake.answers[0].show_alert], ['Action non autorisée.', true]);
    assert.equal(fake.edits.length, 0);

    fake.queue = [click('ok', { update_id: 21 })];
    await until(() => fake.answers.length === 2);
    assert.equal(fake.answers[1].text, 'Déjà marqué comme lu.');
    fake.queue = [click('n’importe quoi', { update_id: 22 })];
    await until(() => fake.answers.length === 3);
    assert.equal(fake.answers[2].text, 'Ce bouton n’est plus valable.');
    assert.equal(calls.length, 0);

    mode = 'zero';
    fake.queue = [click('lu:5:42', { update_id: 23 })];
    await until(() => fake.answers.length === 4);
    assert.equal(fake.answers[3].text, 'Déjà marqué comme lu.');

    mode = 'boom';
    fake.queue = [click('lu:5:42', { update_id: 24 })];
    await until(() => fake.answers.length === 5);
    assert.deepEqual([fake.answers[4].text, fake.answers[4].show_alert], ['Échec : réessayez depuis VigieWeb.', true]);

    mode = 'one';
    fake.queue = [click('lu:5:42', { update_id: 25 })];
    await until(() => fake.answers.length === 6);
    assert.equal(fake.answers[5].text, 'Alerte marquée comme lue.', 'la boucle a survécu à l’échec');
  } finally { poller.stop(); }
});

test('interrogation : inactive sans réglage Telegram ou boutons coupés, reprise dès que les réglages changent', async () => {
  reset();
  let t = { token: 'T3:IDLE', chatId: '42', enabled: false, buttons: true };
  const poller = startTelegramPoller({ settings: () => t, onRead: () => 0, pollSeconds: 0, idleMs: 20, log: { warn() {}, error() {} } });
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pollsOf('T3:IDLE').length, 0, 'notifications coupées : aucun appel à Telegram');
    t = { ...t, enabled: true, buttons: false };
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(pollsOf('T3:IDLE').length, 0, 'boutons coupés : aucun appel');
    t = { ...t, buttons: true };
    await until(() => pollsOf('T3:IDLE').length > 0);
  } finally { poller.stop(); }
});

test('interrogation : conflit passager repris, webhook signalé une seule fois, arrêt immédiat', async () => {
  reset();
  fake.getUpdatesStatus = [409, 'Conflict: terminated by other getUpdates request', 'T4:CONF'];
  fake.once = true;
  const t0 = Date.now();
  const p1 = startTelegramPoller({ settings: () => ({ token: 'T4:CONF', chatId: '42', enabled: true, buttons: true }), onRead: () => 0, pollSeconds: 0, idleMs: 20, log: { warn() {}, error() {} } });
  try {
    await until(() => pollsOf('T4:CONF').length >= 2, 5000);
    assert.ok(Date.now() - t0 < 3500, 'reprise en environ une seconde');
  } finally { p1.stop(); }

  reset();
  fake.getUpdatesStatus = [409, 'Conflict: can\'t use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first', 'T5:HOOK'];
  const warnings = [];
  const p2 = startTelegramPoller({ settings: () => ({ token: 'T5:HOOK', chatId: '42', enabled: true, buttons: true }), onRead: () => 0, pollSeconds: 0, idleMs: 20, log: { warn: (m) => warnings.push(m), error() {} } });
  await until(() => warnings.length === 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pollsOf('T5:HOOK').length, 1, 'pas de boucle serrée : le bot est laissé tranquille');
  assert.match(warnings[0], /webhook/);
  const t1 = Date.now();
  p2.stop();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(Date.now() - t1 < 1000, 'stop() n’attend pas les 10 minutes de repos');

  reset();
  fake.getUpdatesStatus = [401, 'Unauthorized', 'T6:BAD'];
  const warn2 = [];
  const p3 = startTelegramPoller({ settings: () => ({ token: 'T6:BAD', chatId: '42', enabled: true, buttons: true }), onRead: () => 0, pollSeconds: 0, idleMs: 20, log: { warn: (m) => warn2.push(m), error() {} } });
  await until(() => warn2.length === 1);
  assert.match(warn2[0], /jeton refusé/);
  p3.stop();
});

test('« Détecter » : demande explicitement les messages, et retrouve la conversation d’un clic', async () => {
  reset();
  fake.queue = [{ update_id: 1, message: { chat: { id: 555, type: 'private', first_name: 'Arnaud' } } }];
  const chats = await tg.detectChats('D:DETECT');
  assert.equal(chats[0].id, '555');
  assert.ok(pollsOf('D:DETECT')[0].allowed_updates.includes('message'), 'sinon Telegram réutiliserait « callback_query » seul');
});

test('serveur : le lecteur démarre, suit les réglages enregistrés et répond au clic', async () => {
  reset();
  const srv = await startServer({ env: { TELEGRAM_POLL: '1', TELEGRAM_API: `http://127.0.0.1:${server.address().port}` } });
  try {
    assert.equal(await srv.login(), 200);
    const s = await srv.put('/api/settings', { telegram: { token: 'T7:SRV', chatId: '42', enabled: true } });
    assert.equal(s.json.telegram.buttons, true, 'boutons actifs par défaut');
    fake.queue = [click('lu:999:5', { update_id: 30 })];
    await until(() => fake.answers.length === 1, 8000);
    assert.equal(fake.answers[0].text, 'Déjà marqué comme lu.', 'site inconnu : rien à marquer, mais le clic reçoit sa réponse');

    const off = await srv.put('/api/settings', { telegram: { buttons: false } });
    assert.equal(off.json.telegram.buttons, false);
    await new Promise((r) => setTimeout(r, 500));
    const n = pollsOf('T7:SRV').length;
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(pollsOf('T7:SRV').length - n <= 1, 'boutons coupés : l’interrogation s’arrête');
  } finally { await srv.stop(); }
});

test.after(() => { server.close(); dbm.db.close(); });
