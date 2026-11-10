<?php
// Bouchons minimaux de WordPress et de PrestaShop pour exécuter la colle des plugins (route « code ») en ligne de commande.
//   php plugin-stubs.php wp <dossier-du-site>   |   php plugin-stubs.php ps <dossier-du-site>
// Chaque scénario appelle deux fois la route (relevés successifs) et imprime les rapports en JSON.
$kind = $argv[1];
$root = rtrim($argv[2], '/');
$pluginRoot = dirname(__DIR__) . '/plugins';

if ($kind === 'wp') {
    define('ABSPATH', $root . '/');
    define('WP_CONTENT_DIR', $root . '/wp-content');
    define('WP_PLUGIN_DIR', $root . '/wp-content/plugins');
    define('WPMU_PLUGIN_DIR', $root . '/wp-content/mu-plugins');
    $stateFile = $root . '.opts.json';
    $GLOBALS['opts'] = is_file($stateFile) ? json_decode(file_get_contents($stateFile), true) : array();
    $GLOBALS['trans'] = array();
    function add_action() {}
    function add_filter() {}
    function plugin_basename($f) { return basename($f); }
    function register_uninstall_hook() {}
    function register_setting() {}
    function admin_url() { return ''; }
    function get_option($k, $d = false) { return array_key_exists($k, $GLOBALS['opts']) ? $GLOBALS['opts'][$k] : $d; }
    function update_option($k, $v) { $GLOBALS['opts'][$k] = $v; return true; }
    function get_transient($k) { return array_key_exists($k, $GLOBALS['trans']) ? $GLOBALS['trans'][$k] : false; }
    function set_transient($k, $v) { $GLOBALS['trans'][$k] = $v; return true; }
    function get_site_transient($k) { return false; }
    function wp_json_encode($v) { return json_encode($v); }
    function wp_get_upload_dir() { return array('basedir' => WP_CONTENT_DIR . '/uploads'); }
    function get_plugins() { return array(); }
    class FakeTheme {
        public $dir; public $ver;
        public function __construct($d, $v) { $this->dir = $d; $this->ver = $v; }
        public function get($k) { return $k === 'Version' ? $this->ver : ''; }
        public function get_stylesheet_directory() { return $this->dir; }
    }
    function wp_get_themes() {
        $out = array();
        $dir = WP_CONTENT_DIR . '/themes';
        foreach (is_dir($dir) ? scandir($dir) : array() as $n) {
            if ($n[0] !== '.') { $out[$n] = new FakeTheme($dir . '/' . $n, getenv('THEME_VERSION') ?: '1.0'); }
        }
        return $out;
    }
    class WP_REST_Request {
        public $h = array();
        public function __construct($h = array()) { $this->h = $h; }
        public function get_header($k) { return isset($this->h[$k]) ? $this->h[$k] : ''; }
    }
    require $pluginRoot . '/wordpress/suricateweb/suricateweb.php';
    $res = array();
    foreach (array_slice($argv, 3) as $step) {
        $headers = $step === 'off' ? array('x-suricate-code' => '0') : ($step === 'refresh' ? array('x-suricate-refresh' => '1') : array());
        $res[] = suricateweb_code(new WP_REST_Request($headers));
        if ($step !== 'off') { $GLOBALS['trans'] = array(); } // chaque relevé repart sans cache de réponse (l'inventaire, lui, est persistant)
    }
    file_put_contents($stateFile, json_encode($GLOBALS['opts']));
    echo json_encode($res);
} else {
    define('_PS_VERSION_', '8.1.7');
    define('_PS_ROOT_DIR_', $root);
    define('_PS_MODULE_DIR_', $root . '/modules/');
    class Module {}
    class Configuration {}
    require $pluginRoot . '/prestashop/suricateweb/suricateweb.php';
    $m = (new ReflectionClass('Suricateweb'))->newInstanceWithoutConstructor();
    $build = new ReflectionMethod('Suricateweb', 'buildCode');
    $res = array();
    foreach (array_slice($argv, 3) as $step) {
        if ($step === 'off') { $_SERVER['HTTP_X_SURICATE_CODE'] = '0'; } else { unset($_SERVER['HTTP_X_SURICATE_CODE']); }
        $res[] = $build->invoke($m);
    }
    echo json_encode($res);
}
