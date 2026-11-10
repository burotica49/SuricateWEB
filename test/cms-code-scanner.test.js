// Scanner de code suspect des plugins (WordPress et PrestaShop) : signatures, dérive (nouveau / modifié), fichiers chiffrés par un éditeur,
// inventaire d'un relevé à l'autre, et absence de toute fuite de contenu. Le PHP est exécuté pour de bon (CLI) ; sans PHP, les tests sont ignorés.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const php = spawnSync('php', ['-v'], { encoding: 'utf8' });
const skip = php.status !== 0 && 'PHP (ligne de commande) introuvable';
const WP = new URL('../plugins/wordpress/suricateweb/scanner.php', import.meta.url).pathname;
const PS = new URL('../plugins/prestashop/suricateweb/scanner.php', import.meta.url).pathname;
const CLI = new URL('../test-support/scan-cli.php', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'suricate-scan-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function run(scanner, input) {
  const f = join(tmp, `in-${++seq}.json`);
  writeFileSync(f, JSON.stringify(input));
  const r = spawnSync('php', ['-d', 'display_errors=1', CLI, scanner, f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

// Les motifs sont assemblés ici (jamais écrits d'un bloc) : ce dépôt ne contient aucune ligne qui ressemble à du code malveillant.
const E = 'ev' + 'al';
const B64 = 'base' + '64_decode';
const sig = (...parts) => parts.join('');

test('les deux plugins embarquent exactement le même scanner', () => {
  assert.equal(readFileSync(WP, 'utf8'), readFileSync(PS, 'utf8'), 'plugins/wordpress/.../scanner.php et plugins/prestashop/.../scanner.php doivent rester identiques');
});

test('signatures : motifs forts, indices cumulés, code légitime ignoré', { skip }, () => {
  const cases = [
    ['décodage puis exécution', `<?php ${E}(${B64}('QQ==')); ?>`, 's', 'eval_decode'],
    ['décodage compressé et assert', `<?php @assert(gzinflate(${B64}($x)));`, 's', 'eval_decode'],
    ['fonction choisie par le visiteur', sig('<?php $_POST', "['f']", '($_POST', "['a']);"), 's', 'request_func'],
    ['exécution de la requête', `<?php system($_GET['c']);`, 's', 'request_exec'],
    ['rappel choisi par le visiteur', `<?php array_map($_REQUEST['f'], [1]);`, 's', 'request_exec'],
    ['preg_replace avec /e', `<?php preg_replace('/x/e', $b, $c);`, 's', 'preg_e'],
    ['écriture d’un fichier PHP', `<?php file_put_contents('a.php', '<?php echo 1;');`, 's', 'write_php'],
    ['indice isolé : create_function', '<?php $f = create_function(\'$a\', \'return $a;\');', '', null],
    ['deux indices : create_function + eval variable', `<?php $f = create_function('', ''); ${E}($code);`, 'r', 'create_function'],
    ['longue chaîne encodée seule : rien', `<?php $x = '${'A'.repeat(500)}';`, '', null],
    ['longue chaîne encodée + eval variable', `<?php $x = '${'A'.repeat(500)}'; ${E}($x);`, 'r', 'long_encoded'],
    ['JavaScript obfusqué dans un thème', `<script>${E}(unescape('%61%6c'))</script>`, 'r', 'js_obfuscated'],
    ['cloaking par User-Agent', `<?php if (strpos($_SERVER['HTTP_USER_AGENT'], 'Googlebot') !== false) { header('Location: http://spam.example/'); }`, 'r', 'cloaking'],
    ['variables illisibles + goto : cumul', `<?php ${'$OOOOOO = 1; '.repeat(6)} ${'goto a1; '.repeat(9)}`, 'r', 'obfuscated_names'],
    ['code ordinaire : rien', "<?php\nfunction add_two($a, $b) { return $a + $b; }\narray_filter($_POST);\nforeach ($items as $item) { echo esc_html($item); }\n", '', null],
    ['array_filter($_POST) seul reste légitime', `<?php $clean = array_filter($_POST);`, '', null],
  ];
  const out = run(WP, { mode: 'text', cases: cases.map(([, text]) => ({ text })) });
  cases.forEach(([label, , level, hit], i) => {
    assert.equal(out[i].level, level, `${label} : niveau ${out[i].level} (attendu « ${level} »), indices ${out[i].hits}`);
    if (hit) assert.ok(out[i].hits.includes(hit), `${label} : indice « ${hit} » absent (${out[i].hits})`);
  });
});

test('code chiffré par un éditeur (ionCube, SourceGuardian, Zend Guard) : classé à part, jamais un motif fort', { skip }, () => {
  const encoded = [
    `<?php //0046a\nif(!extension_loaded('ionCube Loader')){die('Loader requis');}\n${E}(${B64}('AAAA'));`,
    `<?php if (!function_exists('sg_load')) { die(); } $x = sg_load('ABCD');`,
    `<?php @Zend; 2; ${E}(${B64}('AAAA'));`,
  ];
  const out = run(WP, { mode: 'text', cases: encoded.map((text) => ({ text })) });
  for (const r of out) assert.deepEqual([r.level, r.hits], ['v', ['vendor_encoder']]);
});

test('configuration du serveur : auto_prepend_file, PHP exécuté dans des images, réécriture pour les robots', { skip }, () => {
  const cases = [
    ['php_value auto_prepend_file /tmp/x.php\n', 's', 'auto_prepend'],
    ['auto_prepend_file = "/home/site/.cache/a.php"\n', 's', 'auto_prepend'],
    ['AddHandler application/x-httpd-php .jpg .png\n', 's', 'handler_media'],
    ['RewriteCond %{HTTP_USER_AGENT} (googlebot|bingbot) [NC]\nRewriteRule ^(.*)$ http://spam.example/$1 [R=302,L]\n', 'r', 'htaccess_cloak'],
    ['# BEGIN WordPress\nRewriteEngine On\nRewriteRule ^index\\.php$ - [L]\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteRule . /index.php [L]\n# END WordPress\n', '', null],
  ];
  const out = run(WP, { mode: 'text', cases: cases.map(([text]) => ({ text, config: true })) });
  cases.forEach(([text, level, hit], i) => {
    assert.equal(out[i].level, level, `${text.slice(0, 40)} : ${out[i].level}`);
    if (hit) assert.ok(out[i].hits.includes(hit));
  });
  // Les règles de configuration ne s'appliquent pas à un fichier PHP, et inversement.
  const php = run(WP, { mode: 'text', cases: [{ text: 'php_value auto_prepend_file /tmp/x.php' }, { text: `${E}(${B64}('x'))`, config: true }] });
  assert.deepEqual(php.map((r) => r.level), ['', '']);
});

test('dérive : première analyse = référence ; fichier nouveau ou modifié ensuite = changement ; mise à jour de version = attendu', { skip }, () => {
  const dir = join(tmp, 'site');
  const theme = join(dir, 'wp-content', 'themes', 'mon-theme');
  mkdirSync(theme, { recursive: true });
  writeFileSync(join(theme, 'functions.php'), '<?php function ok() { return 1; }');
  writeFileSync(join(theme, 'old.php'), `<?php ${E}(${B64}('QQ=='));`); // déjà infecté AVANT la première analyse
  writeFileSync(join(theme, 'style.css'), 'body {}'); // pas du PHP : ignoré
  const comp = (version) => [{ id: 'theme:mon-theme', version, paths: [{ path: theme, recursive: true }] }];
  const DAY = 86400;
  const T0 = 1_800_000_000;

  // 1) Première analyse : l'existant est une référence ('baseline'), même infecté ; le contenu ne sort jamais.
  let r = run(WP, { mode: 'run', components: comp('1.0'), inventory: {}, now: T0, root: dir });
  assert.equal(r.report.baseline, true);
  assert.deepEqual(r.report.files.map((f) => [f.path, f.level, f.origin]), [['wp-content/themes/mon-theme/old.php', 'strong', 'baseline']]);
  assert.equal(r.report.inventory, 2, 'deux fichiers PHP suivis (pas le .css)');
  assert.deepEqual(r.report.drift.files, []);
  const wire = JSON.stringify(r.report);
  assert.ok(!wire.includes('QQ==') && !wire.includes(`${B64}(`), 'aucun contenu de fichier dans la réponse (seulement chemins, identifiants de motifs et empreintes courtes)');
  assert.match(r.report.files[0].hash, /^[0-9a-f]{10}$/);

  // 2) Relevé suivant sans changement : même verdict, pas de dérive.
  r = run(WP, { mode: 'run', components: comp('1.0'), inventory: r.inventory, now: T0 + DAY, root: dir });
  assert.equal(r.report.baseline, false);
  assert.deepEqual(r.report.files.map((f) => f.origin), ['baseline']);
  assert.deepEqual(r.report.drift.files, []);

  // 3) Un fichier apparaît et un autre est modifié, SANS changement de version : changements (le nouveau est infecté, l'autre sans motif).
  writeFileSync(join(theme, 'wp-feed.php'), `<?php system($_GET['c']);`);
  writeFileSync(join(theme, 'functions.php'), '<?php function ok() { return 2; }');
  r = run(WP, { mode: 'run', components: comp('1.0'), inventory: r.inventory, now: T0 + 2 * DAY, root: dir });
  assert.deepEqual(r.report.files.map((f) => [f.path.split('/').pop(), f.level, f.origin]), [['wp-feed.php', 'strong', 'change'], ['old.php', 'strong', 'baseline']], 'le changement passe avant la référence');
  assert.deepEqual(r.report.drift.files, ['wp-content/themes/mon-theme/functions.php'], 'fichier modifié sans motif : listé comme dérive, sans alerte');
  const kept = r.inventory;

  // 4) La dérive s'efface après 14 jours, le fichier infecté de changement reste signalé tant qu'il existe.
  r = run(WP, { mode: 'run', components: comp('1.0'), inventory: kept, now: T0 + 20 * DAY, root: dir });
  assert.deepEqual(r.report.drift.files, []);
  assert.equal(r.report.files.length, 2);

  // 5) Mise à jour de version du thème : ses nouveautés sont attendues (« baseline »), pas un changement.
  writeFileSync(join(theme, 'wp-feed.php'), `<?php system($_GET['x']);`);
  r = run(WP, { mode: 'run', components: comp('1.1'), inventory: kept, now: T0 + 21 * DAY, root: dir });
  assert.deepEqual(r.report.files.filter((f) => f.path.endsWith('wp-feed.php')).map((f) => f.origin), ['baseline']);

  // 6) Fichier supprimé : il disparaît de l'inventaire et du rapport.
  rmSync(join(theme, 'old.php'));
  r = run(WP, { mode: 'run', components: comp('1.1'), inventory: r.inventory, now: T0 + 22 * DAY, root: dir });
  assert.ok(!r.report.files.some((f) => f.path.endsWith('old.php')));
  // Le scanner de PrestaShop (copie identique) donne le même résultat.
  const ps = run(PS, { mode: 'run', components: comp('1.1'), inventory: r.inventory, now: T0 + 23 * DAY, root: dir });
  assert.deepEqual(ps.report.files, r.report.files);
});

test('temps imparti : un composant non traité garde son état et passe en premier au relevé suivant', { skip }, () => {
  const dir = join(tmp, 'site2');
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, 'a.php'), '<?php echo 1;');
  writeFileSync(join(b, 'b.php'), `<?php ${E}(${B64}('x'));`);
  const comps = [{ id: 'a', version: '', paths: [{ path: a, recursive: true }] }, { id: 'b', version: '', paths: [{ path: b, recursive: true }] }];
  // Budget nul : rien n'est traité, le rapport le dit.
  let r = run(WP, { mode: 'run', components: comps, inventory: {}, now: 1000, root: dir, budget: -1 });
  assert.equal(r.report.partial, true);
  assert.deepEqual(r.report.files, []);
  // Budget normal : tout est vu.
  r = run(WP, { mode: 'run', components: comps, inventory: r.inventory, now: 2000, root: dir });
  assert.equal(r.report.partial, false);
  assert.deepEqual(r.report.files.map((f) => f.path), ['b/b.php']);
});

// ───────────── Colle des plugins (route « code ») : bouchons WordPress / PrestaShop ─────────────

const STUBS = new URL('../test-support/plugin-stubs.php', import.meta.url).pathname;
const stubRun = (kind, site, steps, env = {}) => {
  const r = spawnSync('php', ['-d', 'display_errors=1', STUBS, kind, site, ...steps], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
};
const put = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };

test('plugins : « php -l » sur tous les fichiers PHP', { skip }, () => {
  for (const f of ['plugins/wordpress/suricateweb/suricateweb.php', 'plugins/wordpress/suricateweb/scanner.php', 'plugins/prestashop/suricateweb/suricateweb.php', 'plugins/prestashop/suricateweb/scanner.php', 'plugins/prestashop/suricateweb/status.php']) {
    const r = spawnSync('php', ['-l', new URL(`../${f}`, import.meta.url).pathname], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f} : ${r.stdout}${r.stderr}`);
  }
});

test('plugin WordPress : route « code » de bout en bout (thèmes, drop-in, .htaccess, wp-config.php), inventaire gardé entre deux relevés, interrupteur', { skip }, () => {
  const site = join(tmp, 'wp');
  put(join(site, 'wp-content/themes/mon-theme/functions.php'), '<?php function ok() { return 1; }');
  put(join(site, 'wp-content/themes/mon-theme/legacy.php'), `<?php ${E}(${B64}('QQ=='));`); // déjà là avant la 1re analyse
  put(join(site, 'wp-content/object-cache.php'), '<?php // drop-in sain');
  put(join(site, '.htaccess'), '# BEGIN WordPress\nRewriteEngine On\n# END WordPress\n');
  put(join(site, 'wp-config.php'), '<?php define("DB_NAME", "x");');
  put(join(site, 'wp-admin/includes/plugin.php'), '<?php');
  const [first] = stubRun('wp', site, ['x']);
  assert.equal(first.cms, 'wordpress');
  assert.equal(first.code.persistent, true);
  assert.equal(first.code.baseline, true);
  assert.deepEqual(first.code.files.map((f) => [f.path, f.level, f.origin]), [['wp-content/themes/mon-theme/legacy.php', 'strong', 'baseline']]);
  assert.ok(first.code.inventory >= 4, `inventaire : ${first.code.inventory} fichiers (thème ×2, drop-in, wp-config.php, .htaccess)`);

  // Relevé suivant : un fichier ajouté au thème, une règle ajoutée à .htaccess.
  put(join(site, 'wp-content/themes/mon-theme/header-x.php'), `<?php system($_GET['c']);`);
  put(join(site, '.htaccess'), '# BEGIN WordPress\nphp_value auto_prepend_file /tmp/p.php\n# END WordPress\n');
  const [second] = stubRun('wp', site, ['x']); // nouveau processus : l'inventaire revient de l'option WordPress
  assert.equal(second.code.baseline, false);
  assert.deepEqual(second.code.files.map((f) => [f.path, f.level, f.origin]), [
    ['.htaccess', 'strong', 'change'], ['wp-content/themes/mon-theme/header-x.php', 'strong', 'change'], ['wp-content/themes/mon-theme/legacy.php', 'strong', 'baseline'],
  ]);

  // Interrupteur : en-tête « X-Suricate-Code: 0 » → rien n'est lu ni haché.
  const [off] = stubRun('wp', site, ['off']);
  assert.deepEqual(off.code, { enabled: false });
});

test('module PrestaShop : buildCode de bout en bout (modules, thèmes, cœur), inventaire dans var/, interrupteur', { skip }, () => {
  const site = join(tmp, 'ps');
  put(join(site, 'modules/monmodule/monmodule.php'), '<?php class Monmodule {}');
  put(join(site, 'modules/monmodule/config.xml'), '<module><version><![CDATA[2.0.1]]></version></module>');
  put(join(site, 'themes/classic/config/theme.yml'), "name: classic\nversion: 1.2.3\n");
  put(join(site, 'themes/classic/templates/x.php'), '<?php echo 1;');
  put(join(site, 'classes/Db.php'), '<?php class Db {}');
  put(join(site, 'index.php'), '<?php header("Location: ../");');
  put(join(site, 'var/.keep'), '');
  const [first] = stubRun('ps', site, ['x']);
  assert.equal(first.cms, 'prestashop');
  assert.deepEqual([first.code.persistent, first.code.baseline, first.code.files], [true, true, []]);
  assert.equal(first.code.inventory, 4, 'les 4 fichiers PHP (module, thème, classes, index.php) ; config.xml et theme.yml ne sont pas du code');
  assert.ok(readFileSync(join(site, 'var/suricateweb-code.json'), 'utf8').includes('module:monmodule'), 'inventaire écrit dans var/');
  // Un module reçoit un fichier suspect SANS changer de version : changement.
  put(join(site, 'modules/monmodule/ajax.php'), `<?php ${E}(${B64}($_POST['d']));`);
  const [second] = stubRun('ps', site, ['x']); // nouveau processus : l'inventaire revient de var/
  assert.deepEqual(second.code.files.map((f) => [f.path, f.level, f.origin]), [['modules/monmodule/ajax.php', 'strong', 'change']]);
  const [off] = stubRun('ps', site, ['off']);
  assert.deepEqual(off.code, { enabled: false });
});

test('le scanner ne se signale pas lui-même', { skip }, () => {
  const out = run(WP, { mode: 'text', cases: [{ text: readFileSync(WP, 'utf8') }, { text: readFileSync(new URL('../plugins/wordpress/suricateweb/suricateweb.php', import.meta.url).pathname, 'utf8') }] });
  assert.deepEqual(out.map((r) => r.level), ['', ''], `faux positif sur nos propres fichiers : ${JSON.stringify(out)}`);
});
