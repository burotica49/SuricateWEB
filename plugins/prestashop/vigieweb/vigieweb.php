<?php
if (!defined('_PS_VERSION_')) {
    exit;
}

class Vigieweb extends Module
{
    public function __construct()
    {
        $this->name = 'vigieweb';
        $this->tab = 'administration';
        $this->version = '1.1.0';
        $this->author = 'VigieWeb';
        $this->need_instance = 0;
        $this->bootstrap = true;
        parent::__construct();
        $this->displayName = $this->l('VigieWeb');
        $this->description = $this->l('Indique à VigieWeb la version de PHP, les mises à jour disponibles, le nombre d’administrateurs et les fichiers PHP suspects dans les dossiers d’images et de téléversements. VigieWeb interroge la boutique ; le module n’envoie rien de lui-même.');
        $this->ps_versions_compliancy = array('min' => '1.7.6.0', 'max' => _PS_VERSION_);
    }

    public function install()
    {
        return parent::install()
            && Configuration::updateValue('VIGIEWEB_TOKEN', '')
            && Configuration::updateValue('VIGIEWEB_FORCE_AT', '0')
            && Configuration::updateValue('VIGIEWEB_CORE', '');
    }

    public function uninstall()
    {
        Configuration::deleteByName('VIGIEWEB_TOKEN');
        Configuration::deleteByName('VIGIEWEB_FORCE_AT');
        Configuration::deleteByName('VIGIEWEB_CORE');
        return parent::uninstall();
    }

    public function getContent()
    {
        $out = '';
        if (Tools::isSubmit('submitVigieweb')) {
            $token = trim((string) Tools::getValue('VIGIEWEB_TOKEN'));
            if ($token !== '' && strlen($token) < 16) {
                $out .= $this->displayError($this->l('Le jeton doit contenir au moins 16 caractères.'));
            } else {
                Configuration::updateValue('VIGIEWEB_TOKEN', $token);
                $out .= $this->displayConfirmation($this->l('Jeton enregistré. VigieWeb peut maintenant lire les versions.'));
            }
        }
        $token = htmlspecialchars((string) Configuration::get('VIGIEWEB_TOKEN'), ENT_QUOTES, 'UTF-8');
        $action = htmlspecialchars((string) $_SERVER['REQUEST_URI'], ENT_QUOTES, 'UTF-8');
        return $out . '<form method="post" action="' . $action . '" class="defaultForm form-horizontal">
            <div class="panel">
                <div class="panel-heading">' . $this->l('VigieWeb') . '</div>
                <div class="form-group">
                    <label class="control-label col-lg-3">' . $this->l('Jeton') . '</label>
                    <div class="col-lg-6">
                        <input type="text" name="VIGIEWEB_TOKEN" value="' . $token . '" class="form-control" autocomplete="off" spellcheck="false">
                        <p class="help-block">' . $this->l('Collez le jeton affiché dans VigieWeb, sur la fiche du site.') . '</p>
                    </div>
                </div>
                <div class="panel-footer">
                    <button type="submit" name="submitVigieweb" class="btn btn-default pull-right"><i class="process-icon-save"></i> ' . $this->l('Enregistrer') . '</button>
                </div>
            </div>
        </form>';
    }

    public function emitStatus()
    {
        $stored = (string) Configuration::get('VIGIEWEB_TOKEN');
        $given = $this->presentedToken();
        if ($stored === '' || $given === '' || strlen($stored) !== strlen($given) || !hash_equals($stored, $given)) {
            http_response_code(401);
            echo '{"error":"unauthorized"}';
            exit;
        }
        try {
            $scope = isset($_GET['scope']) ? (string) $_GET['scope'] : '';
            $report = $scope === 'integrity' ? $this->buildIntegrity() : $this->buildReport($this->wantsRefresh());
        } catch (Exception $e) {
            http_response_code(500);
            echo '{"error":"failed"}';
            exit;
        }
        echo json_encode($report, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    private function presentedToken()
    {
        $auth = isset($_SERVER['HTTP_AUTHORIZATION']) ? (string) $_SERVER['HTTP_AUTHORIZATION'] : '';
        if ($auth === '' && isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
            $auth = (string) $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
        }
        if ($auth === '' && function_exists('getallheaders')) {
            foreach (getallheaders() as $k => $v) {
                if (strcasecmp((string) $k, 'Authorization') === 0) {
                    $auth = (string) $v;
                }
            }
        }
        if (preg_match('/Bearer\s+(\S+)/i', $auth, $m)) {
            return $m[1];
        }
        if (isset($_SERVER['HTTP_X_VIGIE_TOKEN'])) {
            return trim((string) $_SERVER['HTTP_X_VIGIE_TOKEN']);
        }
        return '';
    }

    private function wantsRefresh()
    {
        $flag = isset($_SERVER['HTTP_X_VIGIE_REFRESH']) ? (string) $_SERVER['HTTP_X_VIGIE_REFRESH'] : '';
        if ($flag !== '1') {
            return false;
        }
        $last = (int) Configuration::get('VIGIEWEB_FORCE_AT');
        if ($last && (time() - $last) < 15 * 60) {
            return false;
        }
        Configuration::updateValue('VIGIEWEB_FORCE_AT', (string) time());
        return true;
    }

    private function buildReport($refresh)
    {
        list($available, $known) = $this->coreAvailable($refresh);
        return array(
            'cms' => 'prestashop',
            'cmsVersion' => _PS_VERSION_,
            'php' => PHP_VERSION,
            'core' => array('current' => _PS_VERSION_, 'available' => $available, 'known' => $known),
            'extensions' => $this->moduleRows($refresh),
            'themes' => $this->themeRows(),
            'admins' => $this->adminReport(),
        );
    }

    /**
     * Administrateurs actifs (profil SuperAdmin) : un compteur seulement. La table des employés ne date pas
     * leur création : VigieWeb détecte donc un nouvel administrateur à l'augmentation du compteur.
     */
    private function adminReport()
    {
        try {
            $profile = defined('_PS_ADMIN_PROFILE_') ? (int) _PS_ADMIN_PROFILE_ : 1;
            $count = (int) Db::getInstance()->getValue(
                'SELECT COUNT(*) FROM `' . _DB_PREFIX_ . 'employee` WHERE `id_profile` = ' . $profile . ' AND `active` = 1',
                false
            );
        } catch (Exception $e) {
            return null;
        }
        return array('count' => $count, 'windowDays' => 0, 'recent' => array());
    }

    /**
     * Intégrité (couverture partielle) : PrestaShop ne publie pas de sommes de contrôle pour les modules ni pour le cœur
     * de façon exploitable ici. Le module cherche donc seulement des fichiers PHP là où il ne devrait pas y en avoir
     * (images, fichiers téléversés, téléchargements) : c'est l'endroit habituel d'une porte dérobée.
     */
    private function buildIntegrity()
    {
        @set_time_limit(60);
        $deadline = microtime(true) + 40;
        $dirs = array('img', 'upload', 'download');
        $root = rtrim(_PS_ROOT_DIR_, '/\\');
        $php = array();
        $scanned = 0;
        $truncated = false;
        foreach ($dirs as $dir) {
            $base = $root . '/' . $dir;
            if (!is_dir($base)) {
                continue;
            }
            try {
                $it = new RecursiveIteratorIterator(
                    new RecursiveDirectoryIterator($base, FilesystemIterator::SKIP_DOTS),
                    RecursiveIteratorIterator::LEAVES_ONLY,
                    RecursiveIteratorIterator::CATCH_GET_CHILD
                );
                foreach ($it as $file) {
                    if (++$scanned > 200000 || microtime(true) > $deadline) {
                        $truncated = true;
                        break 2;
                    }
                    if (!$file->isFile() || $file->isLink() || !preg_match('/\\.(php[0-9]?|phtml|pht|phar)$/i', $file->getFilename())) {
                        continue;
                    }
                    if ($this->isIndexStub($file->getPathname())) {
                        continue;
                    }
                    $php[] = ltrim(str_replace('\\', '/', substr($file->getPathname(), strlen($root))), '/');
                }
            } catch (Exception $e) {
                $truncated = true;
            }
        }
        sort($php);
        return array(
            'cms' => 'prestashop',
            'integrity' => array(
                'core' => array('known' => false, 'checked' => 0, 'modified' => array(), 'added' => array(), 'missing' => array(), 'more' => 0, 'version' => _PS_VERSION_),
                'plugins' => array(),
                'uploads' => array('php' => array_slice($php, 0, 40), 'more' => max(0, count($php) - 40), 'scanned' => $scanned, 'truncated' => $truncated),
                'dirs' => array_map(function ($d) {
                    return $d . '/';
                }, $dirs),
                'partial' => false,
            ),
        );
    }

    /** Le petit index.php que PrestaShop met dans chaque dossier : une simple redirection, sans code. */
    private function isIndexStub($path)
    {
        if (basename($path) !== 'index.php') {
            return false;
        }
        $size = @filesize($path);
        if ($size === false || $size > 2000) {
            return false;
        }
        $raw = (string) @file_get_contents($path);
        if (!preg_match('/header\\s*\\(\\s*[\'"](Location|Expires|Last-Modified|Cache-Control|Pragma)/i', $raw)) {
            return false;
        }
        return !preg_match('/\\b(eval|assert|system|exec|passthru|shell_exec|popen|proc_open|base64_decode|gzinflate|str_rot13|file_put_contents|create_function)\\s*\\(|\\$_(GET|POST|REQUEST|COOKIE|FILES|SERVER)\\b/i', $raw);
    }

    private function coreAvailable($refresh)
    {
        $cache = json_decode((string) Configuration::get('VIGIEWEB_CORE'), true);
        $fresh = is_array($cache) && (time() - (int) (isset($cache['at']) ? $cache['at'] : 0) < 12 * 3600);
        if ($fresh && !$refresh) {
            $version = isset($cache['version']) && $cache['version'] !== '' ? (string) $cache['version'] : null;
            return array($version, !empty($cache['known']));
        }
        $raw = $this->httpGet('https://api.github.com/repos/PrestaShop/PrestaShop/releases/latest');
        $version = null;
        $known = false;
        if ($raw) {
            $json = json_decode($raw, true);
            $tag = isset($json['tag_name']) ? ltrim((string) $json['tag_name'], 'vV') : '';
            if (preg_match('/^\d+\.\d+\.\d+/', $tag)) {
                $known = true;
                if (version_compare($tag, _PS_VERSION_, '>')) {
                    $version = $tag;
                }
            }
        }
        if (!$known && is_array($cache) && !empty($cache['known'])) {
            $version = isset($cache['version']) && $cache['version'] !== '' ? (string) $cache['version'] : null;
            return array($version, true);
        }
        Configuration::updateValue('VIGIEWEB_CORE', json_encode(array('at' => time(), 'version' => $version, 'known' => $known)));
        return array($version, $known);
    }

    private function httpGet($url)
    {
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt_array($ch, array(
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 8,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS => 3,
                CURLOPT_USERAGENT => 'VigieWeb',
            ));
            $body = curl_exec($ch);
            curl_close($ch);
            return is_string($body) && $body !== '' ? $body : null;
        }
        $ctx = stream_context_create(array('http' => array('timeout' => 8, 'header' => "User-Agent: VigieWeb\r\n")));
        $body = @file_get_contents($url, false, $ctx);
        return is_string($body) && $body !== '' ? $body : null;
    }

    private function moduleRows($refresh)
    {
        $rows = array();
        if (class_exists('PrestaShop\\PrestaShop\\Core\\Addon\\Module\\ModuleManagerBuilder')) {
            try {
                $builder = \PrestaShop\PrestaShop\Core\Addon\Module\ModuleManagerBuilder::getInstance();
                $repo = $builder->buildRepository();
                if ($refresh && is_object($repo) && method_exists($repo, 'clearCache')) {
                    $repo->clearCache();
                }
                foreach ($repo->getList() as $module) {
                    $row = $this->rowFromAddon($module);
                    if ($row) {
                        $rows[] = $row;
                    }
                    if (count($rows) >= 400) {
                        return $rows;
                    }
                }
                if ($rows) {
                    return $rows;
                }
            } catch (Exception $e) {
                $rows = array();
            }
        }
        if (!class_exists('Module') || !method_exists('Module', 'getModulesOnDisk')) {
            return $rows;
        }
        foreach (Module::getModulesOnDisk(true) as $module) {
            $current = isset($module->version) ? (string) $module->version : '';
            $remote = isset($module->version_addons) ? (string) $module->version_addons : '';
            $known = $remote !== '';
            $available = ($known && version_compare($remote, $current, '>')) ? $remote : null;
            $name = isset($module->displayName) && $module->displayName ? (string) $module->displayName : (string) $module->name;
            $rows[] = array(
                'name' => $name,
                'slug' => (string) $module->name,
                'current' => $current,
                'available' => $available,
                'active' => (bool) Module::isEnabled($module->name),
                'known' => $known,
            );
            if (count($rows) >= 400) {
                break;
            }
        }
        return $rows;
    }

    private function rowFromAddon($module)
    {
        $slug = $this->attr($module, array('name'));
        if ($slug === '') {
            return null;
        }
        $current = $this->attr($module, array('version'));
        $name = $this->attr($module, array('displayName', 'display_name'));
        $remote = '';
        $known = false;
        foreach (array('version_available', 'version_addons', 'last_version', 'available_version') as $key) {
            if ($this->hasAttr($module, $key)) {
                $known = true;
                $remote = $this->attr($module, array($key));
                break;
            }
        }
        $available = ($known && $remote !== '' && version_compare($remote, $current, '>')) ? $remote : null;
        return array(
            'name' => $name !== '' ? $name : $slug,
            'slug' => $slug,
            'current' => $current,
            'available' => $available,
            'active' => (bool) Module::isEnabled($slug),
            'known' => $known,
        );
    }

    private function attr($module, $keys)
    {
        foreach ($keys as $key) {
            $v = $this->readAttr($module, $key);
            if ($v !== null && $v !== '') {
                return $v;
            }
        }
        return '';
    }

    private function hasAttr($module, $key)
    {
        return $this->readAttr($module, $key) !== null;
    }

    private function readAttr($module, $key)
    {
        if (!is_object($module)) {
            return null;
        }
        if (isset($module->attributes)) {
            $a = $module->attributes;
            if (is_object($a) && method_exists($a, 'has') && $a->has($key)) {
                $v = $a->get($key);
                return is_scalar($v) ? (string) $v : null;
            }
            if (is_object($a) && method_exists($a, 'all')) {
                $all = $a->all();
                if (is_array($all) && array_key_exists($key, $all) && is_scalar($all[$key])) {
                    return (string) $all[$key];
                }
            }
            if (is_array($a) && array_key_exists($key, $a) && is_scalar($a[$key])) {
                return (string) $a[$key];
            }
        }
        if (isset($module->$key) && is_scalar($module->$key)) {
            return (string) $module->$key;
        }
        return null;
    }

    private function themeRows()
    {
        $dir = defined('_PS_ALL_THEMES_DIR_') ? _PS_ALL_THEMES_DIR_ : _PS_ROOT_DIR_ . '/themes/';
        $active = '';
        $ctx = Context::getContext();
        if (isset($ctx->shop->theme) && is_object($ctx->shop->theme) && method_exists($ctx->shop->theme, 'getName')) {
            $active = (string) $ctx->shop->theme->getName();
        } elseif (isset($ctx->shop->theme_name)) {
            $active = (string) $ctx->shop->theme_name;
        }
        $rows = array();
        if (!is_dir($dir)) {
            return $rows;
        }
        foreach (scandir($dir) as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $yml = rtrim($dir, '/\\') . '/' . $name . '/config/theme.yml';
            if (!is_file($yml)) {
                continue;
            }
            $raw = (string) @file_get_contents($yml);
            $version = '';
            $label = $name;
            if (preg_match('/^version:\s*[\'"]?([0-9][0-9A-Za-z.+-]*)/m', $raw, $m)) {
                $version = $m[1];
            }
            if (preg_match('/^display_name:\s*[\'"]?(.+?)[\'"]?\s*$/m', $raw, $m)) {
                $label = trim($m[1]);
            }
            $rows[] = array(
                'name' => $label,
                'slug' => $name,
                'current' => $version,
                'available' => null,
                'active' => ($name === $active),
                'known' => false,
            );
            if (count($rows) >= 100) {
                break;
            }
        }
        return $rows;
    }
}
