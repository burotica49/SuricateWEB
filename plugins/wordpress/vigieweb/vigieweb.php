<?php
/**
 * Plugin Name: VigieWeb
 * Description: Indique à VigieWeb la version de PHP, les mises à jour, le nombre d'administrateurs et l'intégrité des fichiers (sommes de contrôle de wordpress.org). VigieWeb interroge ce site ; le plugin n'envoie rien de lui-même.
 * Version: 1.1.0
 * Author: VigieWeb
 * Requires at least: 5.6
 * Requires PHP: 7.2
 * License: MIT
 */

if (!defined('ABSPATH')) {
    exit;
}

add_action('admin_menu', function () {
    add_options_page('VigieWeb', 'VigieWeb', 'manage_options', 'vigieweb', 'vigieweb_options_page');
});

add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($links) {
    $url = admin_url('options-general.php?page=vigieweb');
    array_unshift($links, '<a href="' . esc_url($url) . '">Réglages</a>');
    return $links;
});

add_action('admin_init', function () {
    register_setting('vigieweb', 'vigieweb_token', array(
        'type' => 'string',
        'sanitize_callback' => 'vigieweb_sanitize_token',
        'default' => '',
    ));
});

function vigieweb_sanitize_token($value)
{
    $value = trim((string) $value);
    if ($value !== '' && strlen($value) < 16) {
        add_settings_error('vigieweb_token', 'short', 'Le jeton doit contenir au moins 16 caractères.');
        return (string) get_option('vigieweb_token', '');
    }
    return $value;
}

function vigieweb_options_page()
{
    if (!current_user_can('manage_options')) {
        return;
    }
    echo '<div class="wrap"><h1>VigieWeb</h1>';
    echo '<p>Collez le jeton affiché dans VigieWeb, sur la fiche du site. Rien n’est envoyé : VigieWeb vient lire les versions.</p>';
    echo '<form action="options.php" method="post">';
    settings_fields('vigieweb');
    echo '<table class="form-table"><tr><th scope="row"><label for="vigieweb_token">Jeton</label></th><td>';
    echo '<input name="vigieweb_token" id="vigieweb_token" type="text" class="regular-text" autocomplete="off" spellcheck="false" value="' . esc_attr((string) get_option('vigieweb_token', '')) . '">';
    echo '</td></tr></table>';
    submit_button('Enregistrer');
    echo '</form></div>';
}

register_uninstall_hook(__FILE__, 'vigieweb_uninstall');
function vigieweb_uninstall()
{
    delete_option('vigieweb_token');
    delete_transient('vigieweb_force');
    delete_transient('vigieweb_force_int');
    delete_transient('vigieweb_integrity_cache');
}

add_action('rest_api_init', function () {
    register_rest_route('vigieweb/v1', '/status', array(
        'methods' => 'GET',
        'callback' => 'vigieweb_status',
        'permission_callback' => 'vigieweb_auth',
        'show_in_index' => false,
    ));
    register_rest_route('vigieweb/v1', '/integrity', array(
        'methods' => 'GET',
        'callback' => 'vigieweb_integrity',
        'permission_callback' => 'vigieweb_auth',
        'show_in_index' => false,
    ));
});

function vigieweb_presented_token(WP_REST_Request $req)
{
    $auth = (string) $req->get_header('authorization');
    if (preg_match('/Bearer\s+(\S+)/i', $auth, $m)) {
        return $m[1];
    }
    return trim((string) $req->get_header('x-vigie-token'));
}

function vigieweb_auth(WP_REST_Request $req)
{
    $stored = (string) get_option('vigieweb_token', '');
    $given = vigieweb_presented_token($req);
    if ($stored === '' || $given === '' || strlen($stored) !== strlen($given)) {
        return false;
    }
    return hash_equals($stored, $given);
}

function vigieweb_status(WP_REST_Request $req)
{
    require_once ABSPATH . 'wp-includes/update.php';
    require_once ABSPATH . 'wp-admin/includes/plugin.php';

    $force = strtolower((string) $req->get_header('x-vigie-refresh')) === '1';
    if ($force) {
        $last = (int) get_transient('vigieweb_force');
        if ($last && (time() - $last) < 15 * 60) {
            $force = false;
        } else {
            set_transient('vigieweb_force', time(), 15 * 60);
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
        'admins' => vigieweb_safe_admins(),
    );
}

/** Un compteur d'administrateurs en échec ne doit pas faire échouer tout le relevé des versions. */
function vigieweb_safe_admins()
{
    try {
        return vigieweb_admins();
    } catch (Throwable $e) {
        return null;
    }
}

/**
 * Comptes administrateurs : un compteur et les créations des 30 derniers jours (identifiant, nom de connexion, date).
 * Jamais d'adresse e-mail ni de mot de passe.
 */
function vigieweb_admins()
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
function vigieweb_is_php_file($name)
{
    return (bool) preg_match('/\\.(php[0-9]?|phtml|pht|phar)$/i', $name);
}

/** Les index.php « Silence is golden » que WordPress et de nombreuses extensions déposent partout. */
function vigieweb_is_silence_stub($path)
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
function vigieweb_php_files($dir, $base, $deadline, $limit = 100000, $skipStubs = false)
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
            if (!vigieweb_is_php_file($name)) {
                continue;
            }
            $path = $file->getPathname();
            if ($skipStubs && vigieweb_is_silence_stub($path)) {
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
function vigieweb_hash_matches($path, $expected)
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
function vigieweb_compare_files($root, $sums, $deadline, $skip = null)
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
        if (!vigieweb_hash_matches($path, $expected)) {
            $modified[] = $rel;
        }
    }
    sort($modified);
    sort($missing);
    return array($modified, $missing, $checked);
}

/** Borne une liste pour la réponse : array(les N premiers, nombre omis). */
function vigieweb_cap($list, $max = 40)
{
    $list = array_values($list);
    return array(array_slice($list, 0, $max), max(0, count($list) - $max));
}

function vigieweb_section($known, $checked, $modified, $added, $missing)
{
    list($m, $mMore) = vigieweb_cap($modified);
    list($a, $aMore) = vigieweb_cap($added);
    list($x, $xMore) = vigieweb_cap($missing);
    return array(
        'known' => (bool) $known,
        'checked' => (int) $checked,
        'modified' => $m,
        'added' => $a,
        'missing' => $x,
        'more' => $mMore + $aMore + $xMore,
    );
}

function vigieweb_remote_json($url)
{
    $res = wp_remote_get($url, array('timeout' => 12, 'redirection' => 2, 'user-agent' => 'VigieWeb; ' . home_url('/')));
    if (is_wp_error($res) || (int) wp_remote_retrieve_response_code($res) !== 200) {
        return null;
    }
    $json = json_decode((string) wp_remote_retrieve_body($res), true);
    return is_array($json) ? $json : null;
}

function vigieweb_core_sums($version)
{
    $key = 'vigieweb_core_' . md5($version . get_locale());
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

function vigieweb_plugin_sums($slug, $version)
{
    $key = 'vigieweb_pl_' . md5($slug . '|' . $version);
    $cached = get_transient($key);
    if (is_array($cached)) {
        return $cached ? $cached : null; // tableau vide = version inconnue du dépôt (mémorisé)
    }
    $json = vigieweb_remote_json('https://downloads.wordpress.org/plugin-checksums/' . rawurlencode($slug) . '/' . rawurlencode($version) . '.json');
    $files = ($json && isset($json['files']) && is_array($json['files'])) ? $json['files'] : array();
    set_transient($key, $files, $files ? 6 * 3600 : 1800);
    return $files ? $files : null;
}

/** Chemins du noyau qui ne sont pas un signe d'intrusion s'ils manquent (durcissement courant). */
function vigieweb_core_may_be_absent($rel)
{
    return in_array($rel, array('readme.html', 'license.txt', 'wp-config-sample.php', 'wp-admin/install.php', 'wp-admin/upgrade.php'), true)
        || strpos($rel, 'wp-content/') === 0;
}

function vigieweb_integrity_core($deadline)
{
    global $wp_version;
    $sums = vigieweb_core_sums($wp_version);
    if (!$sums) {
        return array_merge(vigieweb_section(false, 0, array(), array(), array()), array('version' => $wp_version));
    }
    list($modified, $missing, $checked) = vigieweb_compare_files(ABSPATH, $sums, $deadline, function ($rel) {
        return strpos($rel, 'wp-content/') === 0;
    });
    $missing = array_values(array_filter($missing, function ($rel) {
        return !vigieweb_core_may_be_absent($rel);
    }));
    $added = array();
    foreach (array('wp-admin', 'wp-includes') as $dir) {
        list($php) = vigieweb_php_files(ABSPATH . $dir, ABSPATH, $deadline);
        foreach ($php as $rel) {
            if (!isset($sums[$rel])) {
                $added[] = $rel;
            }
        }
    }
    foreach ((array) @scandir(ABSPATH) as $name) {
        $path = rtrim(ABSPATH, '/\\') . '/' . $name;
        if ($name !== '.' && $name !== '..' && is_file($path) && !is_link($path) && vigieweb_is_php_file($name) && $name !== 'wp-config.php' && !isset($sums[$name])) {
            $added[] = $name;
        }
    }
    sort($added);
    return array_merge(vigieweb_section(true, $checked, $modified, $added, $missing), array('version' => $wp_version));
}

/** Slug => true pour les extensions hébergées sur wordpress.org (d'après les informations de mise à jour). */
function vigieweb_official_plugins()
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

function vigieweb_integrity_plugins($deadline, &$partial)
{
    $rows = array();
    $official = vigieweb_official_plugins();
    foreach (get_plugins() as $file => $p) {
        $slug = dirname($file);
        if ($slug === '.') {
            continue; // extension d'un seul fichier : pas de somme de contrôle exploitable
        }
        $version = isset($p['Version']) ? (string) $p['Version'] : '';
        $row = array('name' => isset($p['Name']) && $p['Name'] ? (string) $p['Name'] : $slug, 'slug' => $slug, 'version' => $version);
        if (empty($official[$file]) || $version === '') {
            $rows[] = array_merge($row, vigieweb_section(false, 0, array(), array(), array()));
            continue;
        }
        if (microtime(true) > $deadline) {
            $partial = true;
            $rows[] = array_merge($row, vigieweb_section(false, 0, array(), array(), array()), array('skipped' => true));
            continue;
        }
        $sums = vigieweb_plugin_sums($slug, $version);
        if (!$sums) {
            $rows[] = array_merge($row, vigieweb_section(false, 0, array(), array(), array()));
            continue;
        }
        $root = WP_PLUGIN_DIR . '/' . $slug;
        list($modified, $missing, $checked) = vigieweb_compare_files($root, $sums, $deadline);
        list($php) = vigieweb_php_files($root, $root, $deadline);
        $added = array();
        foreach ($php as $rel) {
            if (!isset($sums[$rel])) {
                $added[] = $rel;
            }
        }
        $rows[] = array_merge($row, vigieweb_section(true, $checked, $modified, $added, $missing));
        if (count($rows) >= 150) {
            break;
        }
    }
    return $rows;
}

function vigieweb_integrity_uploads($deadline)
{
    $dir = wp_get_upload_dir();
    $base = isset($dir['basedir']) ? (string) $dir['basedir'] : '';
    list($php, $scanned, $truncated) = vigieweb_php_files($base, $base, $deadline, 100000, true);
    list($list, $more) = vigieweb_cap($php);
    return array('php' => $list, 'more' => $more, 'scanned' => $scanned, 'truncated' => $truncated);
}

function vigieweb_integrity(WP_REST_Request $req)
{
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    if (function_exists('set_time_limit')) {
        @set_time_limit(90);
    }
    $force = strtolower((string) $req->get_header('x-vigie-refresh')) === '1';
    if ($force) {
        $last = (int) get_transient('vigieweb_force_int');
        if ($last && (time() - $last) < 15 * 60) {
            $force = false;
        } else {
            set_transient('vigieweb_force_int', time(), 15 * 60);
        }
    }
    $cached = get_transient('vigieweb_integrity_cache');
    if (!$force && is_array($cached)) {
        return $cached;
    }
    $deadline = microtime(true) + 60;
    $partial = false;
    $report = array(
        'cms' => 'wordpress',
        'integrity' => array(
            'core' => vigieweb_integrity_core($deadline),
            'plugins' => vigieweb_integrity_plugins($deadline, $partial),
            'uploads' => vigieweb_integrity_uploads($deadline),
            'partial' => $partial || microtime(true) > $deadline,
        ),
    );
    set_transient('vigieweb_integrity_cache', $report, 30 * 60);
    return $report;
}
