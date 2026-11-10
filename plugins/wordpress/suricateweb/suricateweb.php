<?php
/**
 * Plugin Name: SuricateWeb
 * Description: Indique à SuricateWeb la version de PHP, les mises à jour, le nombre d'administrateurs, l'intégrité des fichiers et le code suspect (sommes de contrôle de wordpress.org). SuricateWeb interroge ce site ; le plugin n'envoie rien de lui-même.
 * Version: 1.3.0
 * Author: SuricateWeb
 * Requires at least: 5.6
 * Requires PHP: 7.2
 * License: MIT
 */

if (!defined('ABSPATH')) {
    exit;
}

require_once __DIR__ . '/scanner.php';

add_action('admin_menu', function () {
    add_options_page('SuricateWeb', 'SuricateWeb', 'manage_options', 'suricateweb', 'suricateweb_options_page');
});

add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($links) {
    $url = admin_url('options-general.php?page=suricateweb');
    array_unshift($links, '<a href="' . esc_url($url) . '">Réglages</a>');
    return $links;
});

add_action('admin_init', function () {
    register_setting('suricateweb', 'suricateweb_token', array(
        'type' => 'string',
        'sanitize_callback' => 'suricateweb_sanitize_token',
        'default' => '',
    ));
});

function suricateweb_sanitize_token($value)
{
    $value = trim((string) $value);
    if ($value !== '' && strlen($value) < 16) {
        add_settings_error('suricateweb_token', 'short', 'Le jeton doit contenir au moins 16 caractères.');
        return (string) get_option('suricateweb_token', '');
    }
    return $value;
}

function suricateweb_options_page()
{
    if (!current_user_can('manage_options')) {
        return;
    }
    echo '<div class="wrap"><h1>SuricateWeb</h1>';
    echo '<p>Collez le jeton affiché dans SuricateWeb, sur la fiche du site. Rien n’est envoyé : SuricateWeb vient lire les versions.</p>';
    echo '<form action="options.php" method="post">';
    settings_fields('suricateweb');
    echo '<table class="form-table"><tr><th scope="row"><label for="suricateweb_token">Jeton</label></th><td>';
    echo '<input name="suricateweb_token" id="suricateweb_token" type="text" class="regular-text" autocomplete="off" spellcheck="false" value="' . esc_attr((string) get_option('suricateweb_token', '')) . '">';
    echo '</td></tr></table>';
    submit_button('Enregistrer');
    echo '</form></div>';
}

register_uninstall_hook(__FILE__, 'suricateweb_uninstall');
function suricateweb_uninstall()
{
    delete_option('suricateweb_token');
    delete_transient('suricateweb_force');
    delete_transient('suricateweb_force_int');
    delete_transient('suricateweb_integrity_cache');
    delete_transient('suricateweb_code_cache');
    delete_transient('suricateweb_force_code');
    delete_option('suricateweb_code_inventory');
}

add_action('rest_api_init', function () {
    register_rest_route('suricateweb/v1', '/status', array(
        'methods' => 'GET',
        'callback' => 'suricateweb_status',
        'permission_callback' => 'suricateweb_auth',
        'show_in_index' => false,
    ));
    register_rest_route('suricateweb/v1', '/integrity', array(
        'methods' => 'GET',
        'callback' => 'suricateweb_integrity',
        'permission_callback' => 'suricateweb_auth',
        'show_in_index' => false,
    ));
    register_rest_route('suricateweb/v1', '/code', array(
        'methods' => 'GET',
        'callback' => 'suricateweb_code',
        'permission_callback' => 'suricateweb_auth',
        'show_in_index' => false,
    ));
});

function suricateweb_presented_token(WP_REST_Request $req)
{
    $auth = (string) $req->get_header('authorization');
    if (preg_match('/Bearer\s+(\S+)/i', $auth, $m)) {
        return $m[1];
    }
    return trim((string) $req->get_header('x-suricate-token'));
}

function suricateweb_auth(WP_REST_Request $req)
{
    $stored = (string) get_option('suricateweb_token', '');
    $given = suricateweb_presented_token($req);
    if ($stored === '' || $given === '' || strlen($stored) !== strlen($given)) {
        return false;
    }
    return hash_equals($stored, $given);
}

function suricateweb_status(WP_REST_Request $req)
{
    require_once ABSPATH . 'wp-includes/update.php';
    require_once ABSPATH . 'wp-admin/includes/plugin.php';

    $force = strtolower((string) $req->get_header('x-suricate-refresh')) === '1';
    if ($force) {
        $last = (int) get_transient('suricateweb_force');
        if ($last && (time() - $last) < 15 * 60) {
            $force = false;
        } else {
            set_transient('suricateweb_force', time(), 15 * 60);
            delete_site_transient('update_core');
            delete_site_transient('update_plugins');
            delete_site_transient('update_themes');
        }
    }
    if ($force || !get_site_transient('update_core')) {
        wp_version_check();
    }
    if ($force || !get_site_transient('update_plugins')) {
        wp_update_plugins();
    }
    if ($force || !get_site_transient('update_themes')) {
        wp_update_themes();
    }

    $current = get_bloginfo('version');
    $core = get_site_transient('update_core');
    $available = null;
    $coreKnown = is_object($core);
    if ($coreKnown && !empty($core->updates)) {
        foreach ($core->updates as $u) {
            if (isset($u->response, $u->current) && $u->response === 'upgrade' && $u->current) {
                $available = $u->current;
                break;
            }
        }
    }

    $pluginUpdates = get_site_transient('update_plugins');
    $pluginsKnown = is_object($pluginUpdates);
    $active = array_flip((array) get_option('active_plugins', array()));
    if (is_multisite()) {
        $active += array_flip(array_keys((array) get_site_option('active_sitewide_plugins', array())));
    }
    $extensions = array();
    foreach (get_plugins() as $file => $p) {
        $slug = dirname($file);
        if ($slug === '.') {
            $slug = basename($file, '.php');
        }
        $upd = ($pluginsKnown && isset($pluginUpdates->response[$file])) ? $pluginUpdates->response[$file] : null;
        $extensions[] = array(
            'name' => isset($p['Name']) ? $p['Name'] : $slug,
            'slug' => $slug,
            'current' => isset($p['Version']) ? $p['Version'] : '',
            'available' => ($upd && !empty($upd->new_version)) ? $upd->new_version : null,
            'active' => isset($active[$file]),
            'known' => $pluginsKnown,
        );
    }

    $themeUpdates = get_site_transient('update_themes');
    $themesKnown = is_object($themeUpdates);
    $stylesheet = get_stylesheet();
    $template = get_template();
    $themes = array();
    foreach (wp_get_themes() as $slug => $theme) {
        $upd = ($themesKnown && isset($themeUpdates->response[$slug])) ? $themeUpdates->response[$slug] : null;
        $new = (is_array($upd) && !empty($upd['new_version'])) ? $upd['new_version'] : null;
        $themes[] = array(
            'name' => $theme->get('Name') ?: $slug,
            'slug' => $slug,
            'current' => $theme->get('Version'),
            'available' => $new,
            'active' => ($slug === $stylesheet || $slug === $template),
            'known' => $themesKnown,
        );
    }

    return array(
        'cms' => 'wordpress',
        'cmsVersion' => $current,
        'php' => PHP_VERSION,
        'core' => array('current' => $current, 'available' => $available, 'known' => $coreKnown),
        'extensions' => $extensions,
        'themes' => $themes,
        'admins' => suricateweb_safe_admins(),
    );
}

/** Un compteur d'administrateurs en échec ne doit pas faire échouer tout le relevé des versions. */
function suricateweb_safe_admins()
{
    try {
        return suricateweb_admins();
    } catch (Throwable $e) {
        return null;
    }
}

/**
 * Comptes administrateurs : un compteur et les créations des 30 derniers jours (identifiant, nom de connexion, date).
 * Jamais d'adresse e-mail ni de mot de passe.
 */
function suricateweb_admins()
{
    $window = 30;
    $all = new WP_User_Query(array(
        'role' => 'administrator',
        'number' => 1,
        'fields' => 'ID',
        'count_total' => true,
    ));
    $count = (int) $all->get_total();
    $recent = array();
    $fresh = new WP_User_Query(array(
        'role' => 'administrator',
        'number' => 20,
        'orderby' => 'registered',
        'order' => 'DESC',
        'fields' => array('ID', 'user_login', 'user_registered'),
        'date_query' => array(array(
            'column' => 'user_registered',
            'after' => gmdate('Y-m-d H:i:s', time() - $window * 86400),
            'inclusive' => true,
        )),
    ));
    foreach ((array) $fresh->get_results() as $u) {
        $recent[] = array(
            'id' => (int) $u->ID,
            'login' => (string) $u->user_login,
            'registered' => gmdate('Y-m-d\\TH:i:s\\Z', strtotime($u->user_registered . ' UTC')),
        );
    }
    return array('count' => $count, 'windowDays' => $window, 'recent' => $recent);
}

// ───────────── Intégrité des fichiers ─────────────
//
// Le plugin compare les fichiers du noyau et des extensions du dépôt officiel aux sommes de contrôle publiées par
// wordpress.org, et cherche des fichiers PHP là où il ne devrait pas y en avoir. Il ne renvoie que des chemins relatifs :
// jamais le contenu d'un fichier. Les extensions et thèmes hors dépôt officiel (premium, sur mesure) ne sont pas comparables.

/** Extensions de fichiers que le serveur peut exécuter comme du PHP. */
function suricateweb_is_php_file($name)
{
    return (bool) preg_match('/\\.(php[0-9]?|phtml|pht|phar)$/i', $name);
}

/** Les index.php « Silence is golden » que WordPress et de nombreuses extensions déposent partout. */
function suricateweb_is_silence_stub($path)
{
    if (basename($path) !== 'index.php') {
        return false;
    }
    $size = @filesize($path);
    if ($size === false || $size > 200) {
        return false;
    }
    $raw = (string) @file_get_contents($path);
    return (bool) preg_match('/^<\\?php\\s*(\\/\\/\\s*Silence is golden\\.?\\s*)?$/i', trim($raw));
}

/** Chemins (relatifs à $base, séparateur « / ») des fichiers PHP sous $dir, sans suivre les liens symboliques. */
function suricateweb_php_files($dir, $base, $deadline, $limit = 100000, $skipStubs = false)
{
    $found = array();
    $scanned = 0;
    $truncated = false;
    if (!is_dir($dir)) {
        return array($found, $scanned, $truncated);
    }
    try {
        $it = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::LEAVES_ONLY,
            RecursiveIteratorIterator::CATCH_GET_CHILD
        );
        foreach ($it as $file) {
            if (++$scanned > $limit || microtime(true) > $deadline) {
                $truncated = true;
                break;
            }
            if (!$file->isFile() || $file->isLink()) {
                continue;
            }
            $name = $file->getFilename();
            if (!suricateweb_is_php_file($name)) {
                continue;
            }
            $path = $file->getPathname();
            if ($skipStubs && suricateweb_is_silence_stub($path)) {
                continue;
            }
            $rel = ltrim(str_replace('\\', '/', substr($path, strlen(rtrim($base, '/\\')))), '/');
            $found[] = $rel;
        }
    } catch (Exception $e) {
        $truncated = true;
    }
    sort($found);
    return array($found, $scanned, $truncated);
}

/** Le fichier a-t-il l'une des sommes attendues ? $expected : {md5, sha256} ou une simple chaîne ; chaque valeur peut être une liste. */
function suricateweb_hash_matches($path, $expected)
{
    if (is_string($expected)) {
        $expected = array('md5' => $expected);
    }
    if (!is_array($expected)) {
        return true;
    }
    foreach (array('sha256', 'md5') as $algo) {
        if (empty($expected[$algo])) {
            continue;
        }
        $want = array_map('strtolower', (array) $expected[$algo]);
        $got = @hash_file($algo, $path);
        return $got !== false && in_array(strtolower($got), $want, true);
    }
    return true;
}

/**
 * Compare un dossier à une liste de sommes de contrôle {chemin relatif => somme}.
 * Retourne array(modifiés, manquants, nombre de fichiers vérifiés).
 * $skip : fonction qui dit si un chemin est ignoré (dossiers d'utilisateur, fichiers de durcissement…).
 */
function suricateweb_compare_files($root, $sums, $deadline, $skip = null)
{
    $modified = array();
    $missing = array();
    $checked = 0;
    $root = rtrim($root, '/\\') . '/';
    foreach ($sums as $rel => $expected) {
        if ($skip && call_user_func($skip, $rel)) {
            continue;
        }
        if (microtime(true) > $deadline) {
            break;
        }
        $path = $root . $rel;
        if (!is_file($path)) {
            $missing[] = $rel;
            continue;
        }
        $checked++;
        if (!suricateweb_hash_matches($path, $expected)) {
            $modified[] = $rel;
        }
    }
    sort($modified);
    sort($missing);
    return array($modified, $missing, $checked);
}

/** Borne une liste pour la réponse : array(les N premiers, nombre omis). */
function suricateweb_cap($list, $max = 40)
{
    $list = array_values($list);
    return array(array_slice($list, 0, $max), max(0, count($list) - $max));
}

function suricateweb_section($known, $checked, $modified, $added, $missing)
{
    list($m, $mMore) = suricateweb_cap($modified);
    list($a, $aMore) = suricateweb_cap($added);
    list($x, $xMore) = suricateweb_cap($missing);
    return array(
        'known' => (bool) $known,
        'checked' => (int) $checked,
        'modified' => $m,
        'added' => $a,
        'missing' => $x,
        'more' => $mMore + $aMore + $xMore,
    );
}

function suricateweb_remote_json($url)
{
    $res = wp_remote_get($url, array('timeout' => 12, 'redirection' => 2, 'user-agent' => 'SuricateWeb; ' . home_url('/')));
    if (is_wp_error($res) || (int) wp_remote_retrieve_response_code($res) !== 200) {
        return null;
    }
    $json = json_decode((string) wp_remote_retrieve_body($res), true);
    return is_array($json) ? $json : null;
}

function suricateweb_core_sums($version)
{
    $key = 'suricateweb_core_' . md5($version . get_locale());
    $cached = get_transient($key);
    if (is_array($cached) && $cached) {
        return $cached;
    }
    require_once ABSPATH . 'wp-admin/includes/update.php';
    $sums = function_exists('get_core_checksums') ? get_core_checksums($version, get_locale()) : false;
    if (!is_array($sums) && get_locale() !== 'en_US' && function_exists('get_core_checksums')) {
        $sums = get_core_checksums($version, 'en_US');
    }
    if (!is_array($sums) || !$sums) {
        return null;
    }
    set_transient($key, $sums, 6 * 3600);
    return $sums;
}

function suricateweb_plugin_sums($slug, $version)
{
    $key = 'suricateweb_pl_' . md5($slug . '|' . $version);
    $cached = get_transient($key);
    if (is_array($cached)) {
        return $cached ? $cached : null; // tableau vide = version inconnue du dépôt (mémorisé)
    }
    $json = suricateweb_remote_json('https://downloads.wordpress.org/plugin-checksums/' . rawurlencode($slug) . '/' . rawurlencode($version) . '.json');
    $files = ($json && isset($json['files']) && is_array($json['files'])) ? $json['files'] : array();
    set_transient($key, $files, $files ? 6 * 3600 : 1800);
    return $files ? $files : null;
}

/** Chemins du noyau qui ne sont pas un signe d'intrusion s'ils manquent (durcissement courant). */
function suricateweb_core_may_be_absent($rel)
{
    return in_array($rel, array('readme.html', 'license.txt', 'wp-config-sample.php', 'wp-admin/install.php', 'wp-admin/upgrade.php'), true)
        || strpos($rel, 'wp-content/') === 0;
}

function suricateweb_integrity_core($deadline)
{
    global $wp_version;
    $sums = suricateweb_core_sums($wp_version);
    if (!$sums) {
        return array_merge(suricateweb_section(false, 0, array(), array(), array()), array('version' => $wp_version));
    }
    list($modified, $missing, $checked) = suricateweb_compare_files(ABSPATH, $sums, $deadline, function ($rel) {
        return strpos($rel, 'wp-content/') === 0;
    });
    $missing = array_values(array_filter($missing, function ($rel) {
        return !suricateweb_core_may_be_absent($rel);
    }));
    $added = array();
    foreach (array('wp-admin', 'wp-includes') as $dir) {
        list($php) = suricateweb_php_files(ABSPATH . $dir, ABSPATH, $deadline);
        foreach ($php as $rel) {
            if (!isset($sums[$rel])) {
                $added[] = $rel;
            }
        }
    }
    foreach ((array) @scandir(ABSPATH) as $name) {
        $path = rtrim(ABSPATH, '/\\') . '/' . $name;
        if ($name !== '.' && $name !== '..' && is_file($path) && !is_link($path) && suricateweb_is_php_file($name) && $name !== 'wp-config.php' && !isset($sums[$name])) {
            $added[] = $name;
        }
    }
    sort($added);
    return array_merge(suricateweb_section(true, $checked, $modified, $added, $missing), array('version' => $wp_version));
}

/** Slug => true pour les extensions hébergées sur wordpress.org (d'après les informations de mise à jour). */
function suricateweb_official_plugins()
{
    $official = array();
    $t = get_site_transient('update_plugins');
    if (!is_object($t)) {
        return $official;
    }
    foreach (array('response', 'no_update') as $bucket) {
        foreach ((array) (isset($t->$bucket) ? $t->$bucket : array()) as $file => $item) {
            $id = is_object($item) && isset($item->id) ? (string) $item->id : '';
            $url = is_object($item) && isset($item->url) ? (string) $item->url : '';
            if (strpos($id, 'w.org/') === 0 || strpos($url, 'https://wordpress.org/plugins/') === 0) {
                $official[$file] = true;
            }
        }
    }
    return $official;
}

function suricateweb_integrity_plugins($deadline, &$partial)
{
    $rows = array();
    $official = suricateweb_official_plugins();
    foreach (get_plugins() as $file => $p) {
        $slug = dirname($file);
        if ($slug === '.') {
            continue; // extension d'un seul fichier : pas de somme de contrôle exploitable
        }
        $version = isset($p['Version']) ? (string) $p['Version'] : '';
        $row = array('name' => isset($p['Name']) && $p['Name'] ? (string) $p['Name'] : $slug, 'slug' => $slug, 'version' => $version);
        if (empty($official[$file]) || $version === '') {
            $rows[] = array_merge($row, suricateweb_section(false, 0, array(), array(), array()));
            continue;
        }
        if (microtime(true) > $deadline) {
            $partial = true;
            $rows[] = array_merge($row, suricateweb_section(false, 0, array(), array(), array()), array('skipped' => true));
            continue;
        }
        $sums = suricateweb_plugin_sums($slug, $version);
        if (!$sums) {
            $rows[] = array_merge($row, suricateweb_section(false, 0, array(), array(), array()));
            continue;
        }
        $root = WP_PLUGIN_DIR . '/' . $slug;
        list($modified, $missing, $checked) = suricateweb_compare_files($root, $sums, $deadline);
        list($php) = suricateweb_php_files($root, $root, $deadline);
        $added = array();
        foreach ($php as $rel) {
            if (!isset($sums[$rel])) {
                $added[] = $rel;
            }
        }
        $rows[] = array_merge($row, suricateweb_section(true, $checked, $modified, $added, $missing));
        if (count($rows) >= 150) {
            break;
        }
    }
    return $rows;
}

function suricateweb_integrity_uploads($deadline)
{
    $dir = wp_get_upload_dir();
    $base = isset($dir['basedir']) ? (string) $dir['basedir'] : '';
    list($php, $scanned, $truncated) = suricateweb_php_files($base, $base, $deadline, 100000, true);
    list($list, $more) = suricateweb_cap($php);
    return array('php' => $list, 'more' => $more, 'scanned' => $scanned, 'truncated' => $truncated);
}

function suricateweb_integrity(WP_REST_Request $req)
{
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    if (function_exists('set_time_limit')) {
        @set_time_limit(90);
    }
    $force = strtolower((string) $req->get_header('x-suricate-refresh')) === '1';
    if ($force) {
        $last = (int) get_transient('suricateweb_force_int');
        if ($last && (time() - $last) < 15 * 60) {
            $force = false;
        } else {
            set_transient('suricateweb_force_int', time(), 15 * 60);
        }
    }
    $cached = get_transient('suricateweb_integrity_cache');
    if (!$force && is_array($cached)) {
        return $cached;
    }
    $deadline = microtime(true) + 60;
    $partial = false;
    $report = array(
        'cms' => 'wordpress',
        'integrity' => array(
            'core' => suricateweb_integrity_core($deadline),
            'plugins' => suricateweb_integrity_plugins($deadline, $partial),
            'uploads' => suricateweb_integrity_uploads($deadline),
            'partial' => $partial || microtime(true) > $deadline,
        ),
    );
    set_transient('suricateweb_integrity_cache', $report, 30 * 60);
    return $report;
}

// ───────────── Code suspect (dérive des fichiers + signatures) ─────────────
//
// Voir scanner.php. Route séparée de l'intégrité : un contrôle long ne retarde pas la lecture des sommes de contrôle, et SuricateWeb
// peut le couper pour un site (en-tête X-Suricate-Code: 0). On y regarde ce que les sommes de contrôle ne couvrent pas :
// thèmes, mu-plugins, extensions premium ou sur mesure, drop-ins, wp-config.php, .htaccess et .user.ini.

/** Sommes de contrôle d'une extension déjà en cache (jamais d'appel réseau ici) : si elles existent, l'extension est vérifiée autrement. */
function suricateweb_plugin_sums_cached($slug, $version)
{
    $cached = get_transient('suricateweb_pl_' . md5($slug . '|' . $version));
    return is_array($cached) && $cached;
}

function suricateweb_code_components()
{
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    $c = array();
    foreach (wp_get_themes() as $slug => $theme) {
        $c[] = array('id' => 'theme:' . $slug, 'version' => (string) $theme->get('Version'), 'paths' => array(array('path' => $theme->get_stylesheet_directory(), 'recursive' => true)));
    }
    if (defined('WPMU_PLUGIN_DIR') && is_dir(WPMU_PLUGIN_DIR)) {
        $c[] = array('id' => 'mu-plugins', 'version' => '', 'paths' => array(array('path' => WPMU_PLUGIN_DIR, 'recursive' => true)));
    }
    $official = suricateweb_official_plugins();
    foreach (get_plugins() as $file => $p) {
        $slug = dirname($file);
        if ($slug === '.') {
            continue; // extension d'un seul fichier : couverte par « plugins-root »
        }
        $version = isset($p['Version']) ? (string) $p['Version'] : '';
        if (!empty($official[$file]) && $version !== '' && suricateweb_plugin_sums_cached($slug, $version)) {
            continue; // vérifiée par les sommes de contrôle de wordpress.org : une signature de plus n'apporterait que des faux positifs
        }
        $c[] = array('id' => 'plugin:' . $slug, 'version' => $version, 'paths' => array(array('path' => WP_PLUGIN_DIR . '/' . $slug, 'recursive' => true)));
    }
    $c[] = array('id' => 'plugins-root', 'version' => '', 'paths' => array(array('path' => WP_PLUGIN_DIR, 'recursive' => false)));
    $c[] = array('id' => 'content-root', 'version' => '', 'paths' => array(array('path' => WP_CONTENT_DIR, 'recursive' => false)));
    $root = rtrim(ABSPATH, '/\\');
    $site = array(
        array('path' => ABSPATH, 'recursive' => false, 'only' => 'config'),
        array('path' => $root . '/wp-config.php', 'recursive' => false),
        array('path' => dirname($root) . '/wp-config.php', 'recursive' => false), // wp-config.php est parfois un dossier plus haut
    );
    $c[] = array('id' => 'site-root', 'version' => '', 'paths' => $site);
    $up = wp_get_upload_dir();
    if (!empty($up['basedir']) && is_dir($up['basedir'])) {
        $c[] = array('id' => 'uploads-config', 'version' => '', 'paths' => array(array('path' => $up['basedir'], 'recursive' => true, 'only' => 'config')));
    }
    return $c;
}

function suricateweb_code_inventory_load()
{
    $raw = get_option('suricateweb_code_inventory', '');
    $data = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
    return is_array($data) ? $data : array();
}

function suricateweb_code(WP_REST_Request $req)
{
    if (function_exists('set_time_limit')) {
        @set_time_limit(90);
    }
    if (trim((string) $req->get_header('x-suricate-code')) === '0') {
        return array('cms' => 'wordpress', 'code' => array('enabled' => false));
    }
    $force = strtolower((string) $req->get_header('x-suricate-refresh')) === '1';
    if ($force) {
        $last = (int) get_transient('suricateweb_force_code');
        if ($last && (time() - $last) < 15 * 60) {
            $force = false;
        } else {
            set_transient('suricateweb_force_code', time(), 15 * 60);
        }
    }
    $cached = get_transient('suricateweb_code_cache');
    if (!$force && is_array($cached)) {
        return $cached;
    }
    list($report, $inventory) = suricateweb_scan_run(suricateweb_code_components(), suricateweb_code_inventory_load(), time(), microtime(true) + 45, ABSPATH);
    update_option('suricateweb_code_inventory', wp_json_encode($inventory), false);
    $report['persistent'] = true;
    $out = array('cms' => 'wordpress', 'code' => $report);
    set_transient('suricateweb_code_cache', $out, 20 * 60);
    return $out;
}
