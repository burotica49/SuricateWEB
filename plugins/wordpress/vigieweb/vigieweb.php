<?php
/**
 * Plugin Name: VigieWeb
 * Description: Indique à VigieWeb la version de PHP et les mises à jour du noyau, des extensions et des thèmes. VigieWeb interroge ce site ; le plugin n'envoie rien de lui-même.
 * Version: 1.0.0
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
}

add_action('rest_api_init', function () {
    register_rest_route('vigieweb/v1', '/status', array(
        'methods' => 'GET',
        'callback' => 'vigieweb_status',
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
    );
}
