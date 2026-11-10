<?php
/**
 * SuricateWeb — recherche de code suspect dans les fichiers du site (thèmes, extensions non vérifiables, etc.).
 *
 * Fichier AUTONOME (aucune dépendance à WordPress ni à PrestaShop), identique dans les deux plugins : un test vérifie
 * qu'ils ne divergent jamais. PHP 7.1 minimum.
 *
 * Deux détecteurs complémentaires :
 *  - la DÉRIVE : un inventaire (chemin → empreinte SHA-1) est gardé d'un relevé à l'autre ; un fichier nouveau ou modifié sans
 *    changement de version du thème ou de l'extension est un fait objectif, même si son code est obfusqué ;
 *  - des SIGNATURES : des motifs de code malveillant courants (décodage puis exécution, webshell, redirection cachée…), avec un
 *    score. Un fichier chiffré par un éditeur (ion Cube, Zend Guard, Source Guardian) est reconnu et classé à part : jamais d'alerte.
 *
 * Ce qui sort du site : des chemins relatifs, des identifiants de motifs et des empreintes courtes. JAMAIS le contenu d'un fichier.
 * Ce qui reste sur le site : l'inventaire (chemin + 10 caractères d'empreinte par fichier PHP).
 *
 * Niveaux : 's' = fort (motif quasi sans usage légitime), 'r' = à relire (indices cumulés), 'v' = chiffré par un éditeur.
 * Origine d'un indice : 'b' = déjà là à la première analyse du composant (ou apporté par sa mise à jour), 'c' = apparu depuis
 * (fichier nouveau ou modifié) : seul 'c' justifie une alerte critique.
 */

if (!defined('ABSPATH') && !defined('_PS_VERSION_') && !defined('SURICATEWEB_SCANNER_TEST')) {
    exit;
}

/** Taille maximale lue pour la recherche de motifs (au-delà, seul le début est examiné). */
const SURICATEWEB_SCAN_MAX_READ = 1048576;
/** Au-delà de cette taille, un fichier n'est ni haché ni examiné (un script malveillant est petit ; hacher un gros fichier ferait perdre le temps du contrôle). */
const SURICATEWEB_SCAN_MAX_FILE = 5242880;
/** Fichiers suivis par composant et au total (l'inventaire reste de taille raisonnable). */
const SURICATEWEB_SCAN_MAX_PER_COMPONENT = 20000;
const SURICATEWEB_SCAN_MAX_TOTAL = 60000;
/** Fichiers listés dans la réponse (les plus graves d'abord) ; les autres sont comptés. */
const SURICATEWEB_SCAN_MAX_REPORTED = 60;
/** Durée pendant laquelle un fichier nouveau ou modifié reste signalé comme « changé » même sans signature. */
const SURICATEWEB_SCAN_DRIFT_DAYS = 14;

/** Fichiers PHP (extensions exécutables par le serveur, plus .inc : ils servent à cacher du code). */
function suricateweb_scan_is_php($name)
{
    return (bool) preg_match('/\.(php[0-9]?|phtml|pht|phar|inc)$/i', $name);
}

/** Fichiers de configuration du serveur qui peuvent exécuter ou rediriger sans écrire une ligne de PHP. */
function suricateweb_scan_is_config($name)
{
    return in_array(strtolower($name), array('.htaccess', '.user.ini', 'php.ini', '.php.ini', 'user.ini'), true);
}

/**
 * Les règles : id => array(poids, motif(s), famille). Famille « php » (fichiers PHP) ou « config » (.htaccess, .user.ini…).
 * Un poids de 10 ou plus est un motif FORT ; les autres s'additionnent (6 ou plus : « à relire »).
 * Chaque motif est borné (pas de quantificateur imbriqué) : un fichier hostile ne peut pas figer le contrôle.
 */
function suricateweb_scan_rules()
{
    static $rules = null;
    if ($rules !== null) {
        return $rules;
    }
    $rules = array(
        // ── PHP : motifs forts ──
        'eval_decode' => array(10, array('~\b(?:eval|assert)\s*\(\s*@?\s*(?:base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|rawurldecode|convert_uudecode|hex2bin|strrev)\s*\(~i'), 'php'),
        // Exécution directe de ce qu'envoie le visiteur, ou fonction « rappel » choisie par lui (le tableau seul, comme array_filter($_POST), reste légitime).
        'request_exec' => array(10, array(
            '~\b(?:eval|assert|system|exec|shell_exec|passthru|popen|proc_open|pcntl_exec)\s*\(\s*@?\s*\$_(?:GET|POST|REQUEST|COOKIE|FILES)\b~i',
            '~\b(?:call_user_func(?:_array)?|array_map|array_filter|array_walk|usort|uasort|preg_replace_callback|file_put_contents)\s*\(\s*@?\s*\$_(?:GET|POST|REQUEST|COOKIE|FILES)\s*\[~i',
        ), 'php'),
        'request_func' => array(10, array('~\$_(?:GET|POST|REQUEST|COOKIE)\s*\[[^\]\r\n]{1,40}\]\s*\(~'), 'php'),
        'preg_e' => array(10, array('~preg_replace\s*\(\s*(["\'])(.)(?:(?!\2).){0,200}\2[imsxADSUXu]*e[imsxADSUXu]*\1\s*,~s'), 'php'),
        'write_php' => array(10, array('~\b(?:file_put_contents|fwrite|fputs)\s*\([^;]{0,240}(?:<\?php|<\?=|\\\\x3c\\\\x3f)~i'), 'php'),
        // ── PHP : indices à cumuler ──
        'create_function' => array(3, array('~\bcreate_function\s*\(~i'), 'php'),
        'eval_var' => array(3, array('~\b(?:eval|assert)\s*\(\s*\$\w+~i'), 'php'),
        'long_encoded' => array(3, array('~["\'][A-Za-z0-9+/]{400,}={0,2}["\']~', '~(?:\\\\x[0-9a-f]{2}){40,}~i'), 'php'),
        'chr_chain' => array(4, array('~(?:chr\s*\(\s*\d{1,3}\s*\)\s*\.\s*){8,}~i'), 'php'),
        'js_obfuscated' => array(6, array(
            '~eval\s*\(\s*(?:atob|unescape|String\.fromCharCode)~i',
            '~document\.write\s*\(\s*(?:unescape|atob|String\.fromCharCode)~i',
            '~String\.fromCharCode\s*\((?:\s*\d+\s*,){8,}~i',
            '~function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)~',
        ), 'php'),
        // ── Configuration du serveur ──
        'auto_prepend' => array(10, array('~^\s*(?:php_value\s+)?auto_(?:prepend|append)_file\b~im'), 'config'),
        'handler_media' => array(10, array('~^\s*(?:AddHandler|SetHandler|AddType)\s+[^\r\n]*(?:php|x-httpd)[^\r\n]*\.(?:jpe?g|png|gif|ico|txt|css|js|svg|webp)\b~im'), 'config'),
    );
    return $rules;
}

/** Poids d'un motif fort : au moins ce score = niveau « fort ». */
const SURICATEWEB_SCAN_STRONG = 10;
/** Score cumulé à partir duquel un fichier est « à relire ». */
const SURICATEWEB_SCAN_REVIEW = 6;

/** Marques des fichiers chiffrés PAR UN ÉDITEUR (ion Cube, Zend Guard, Source Guardian) : du code illisible mais légitime. */
function suricateweb_scan_is_vendor_encoded($text)
{
    return (bool) @preg_match('~ion[C]ube\s+Loader|ioncube_[l]oader|extension_loaded\s*\(\s*["\']ion[C]ube|\bsg_load\s*\(|Source[G]uardian|zend_loader_file_[e]ncoded|@Zend[;]|<\?php\s*//\s*0046a~i', substr($text, 0, 4096));
}

/** Compte les occurrences d'un motif, avec un plafond (pas de parcours inutile d'un gros fichier). */
function suricateweb_scan_count($pattern, $text, $cap = 50)
{
    $n = @preg_match_all($pattern, $text, $m);
    return $n === false ? 0 : min($n, $cap);
}

/**
 * Motifs qui demandent un calcul plutôt qu'une simple expression : renvoie les identifiants touchés avec leur poids.
 * @return array<string,int>
 */
function suricateweb_scan_computed($text)
{
    $hits = array();
    // Variables aux noms illisibles ($OOO0OO, $lIIlll, $____) : l'obfuscation par renommage.
    if (suricateweb_scan_count('~\$(?:[Il1]{6,}|[O0o]{6,}|_{4,})~', $text) >= 5) {
        $hits['obfuscated_names'] = 4;
    }
    // Longue chaîne de « goto » : déroule le code dans le désordre.
    if (suricateweb_scan_count('~\bgoto\s+\w+\s*;~i', $text) >= 8) {
        $hits['goto_chain'] = 4;
    }
    // Ligne très longue et presque sans espace : code réduit ou encodé sur une seule ligne.
    foreach (explode("\n", $text) as $line) {
        $len = strlen($line);
        if ($len > 4000 && substr_count($line, ' ') / $len < 0.02) {
            $hits['long_line'] = 3;
            break;
        }
    }
    // Contenu servi autrement aux moteurs de recherche (cloaking) : un User-Agent de robot ET une redirection ou un chargement distant.
    if (@preg_match('~HTTP_USER_AGENT[^;]{0,160}(?:googlebot|bingbot|yandex|baiduspider|slurp|duckduckbot)~i', $text)
        && @preg_match('~(?:header\s*\(\s*["\']Location|wp_redirect|file_get_contents\s*\(\s*["\']https?:|curl_init)~i', $text)) {
        $hits['cloaking'] = 6;
    }
    return $hits;
}

/** Idem pour .htaccess : un contenu réécrit pour les robots (cloaking) et redirigé vers un autre domaine. */
function suricateweb_scan_computed_config($text)
{
    $hits = array();
    if (@preg_match('~RewriteCond\s+%\{HTTP_(?:USER_AGENT|REFERER)\}[^\r\n]*(?:google|bing|yahoo|yandex|baidu|android|iphone)~i', $text)
        && @preg_match('~RewriteRule\s+[^\r\n]*\s+https?://~i', $text)) {
        $hits['htaccess_cloak'] = 6;
    }
    return $hits;
}

/**
 * Examine le texte d'un fichier.
 * @param string $text     Contenu (au plus SURICATEWEB_SCAN_MAX_READ octets).
 * @param bool   $isConfig Vrai pour .htaccess / .user.ini / php.ini.
 * @return array{0:string,1:array<int,string>} Niveau ('s', 'r', 'v' ou '' = rien à signaler) et identifiants des motifs touchés.
 */
function suricateweb_scan_text($text, $isConfig = false)
{
    $family = $isConfig ? 'config' : 'php';
    if (!$isConfig && suricateweb_scan_is_vendor_encoded($text)) {
        return array('v', array('vendor_encoder'));
    }
    $score = 0;
    $strong = false;
    $ids = array();
    foreach (suricateweb_scan_rules() as $id => $rule) {
        if ($rule[2] !== $family) {
            continue;
        }
        foreach ($rule[1] as $pattern) {
            if (@preg_match($pattern, $text)) {
                $ids[] = $id;
                $score += $rule[0];
                $strong = $strong || $rule[0] >= SURICATEWEB_SCAN_STRONG;
                break;
            }
        }
    }
    $extra = $isConfig ? suricateweb_scan_computed_config($text) : suricateweb_scan_computed($text);
    foreach ($extra as $id => $weight) {
        $ids[] = $id;
        $score += $weight;
    }
    if ($strong) {
        return array('s', $ids);
    }
    if ($score >= SURICATEWEB_SCAN_REVIEW) {
        return array('r', $ids);
    }
    return array('', array());
}

/** Lit au plus SURICATEWEB_SCAN_MAX_READ octets d'un fichier, ou null s'il est illisible. */
function suricateweb_scan_read($path)
{
    $fh = @fopen($path, 'rb');
    if (!$fh) {
        return null;
    }
    $data = @fread($fh, SURICATEWEB_SCAN_MAX_READ);
    @fclose($fh);
    return is_string($data) ? $data : null;
}

/** Chemin relatif à la racine du site, séparateur « / », en UTF-8 valide (la réponse est du JSON). */
function suricateweb_scan_rel($abs, $root)
{
    $abs = str_replace('\\', '/', (string) $abs);
    $root = rtrim(str_replace('\\', '/', (string) $root), '/') . '/';
    $rel = strpos($abs, $root) === 0 ? substr($abs, strlen($root)) : ltrim($abs, '/');
    if (!preg_match('//u', $rel)) {
        $clean = @iconv('UTF-8', 'UTF-8//IGNORE', $rel);
        $rel = $clean === false ? '?' : $clean;
    }
    return substr($rel, 0, 200);
}

/**
 * Liste les fichiers d'un composant. `paths` : suite de ['path' => absolu, 'recursive' => bool, 'only' => 'config'|null].
 * Un chemin de fichier est pris tel quel ; un dossier non récursif ne livre que son premier niveau.
 * @return array{0:array<int,string>,1:bool} Fichiers et drapeau « liste tronquée ».
 */
function suricateweb_scan_expand($component, $deadline)
{
    $files = array();
    $truncated = false;
    foreach ($component['paths'] as $p) {
        $path = $p['path'];
        $only = isset($p['only']) ? $p['only'] : null;
        $take = function ($name) use ($only) {
            return $only === 'config' ? suricateweb_scan_is_config($name) : (suricateweb_scan_is_php($name) || suricateweb_scan_is_config($name));
        };
        if (is_file($path) && !is_link($path)) {
            if ($take(basename($path))) {
                $files[] = $path;
            }
            continue;
        }
        if (!is_dir($path)) {
            continue;
        }
        try {
            if (!empty($p['recursive'])) {
                $it = new RecursiveIteratorIterator(
                    new RecursiveCallbackFilterIterator(
                        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
                        function ($current) {
                            $n = $current->getFilename();
                            return !($current->isDir() && ($n === 'node_modules' || $n === '.git' || $current->isLink()));
                        }
                    ),
                    RecursiveIteratorIterator::LEAVES_ONLY,
                    RecursiveIteratorIterator::CATCH_GET_CHILD
                );
            } else {
                $it = new DirectoryIterator($path);
            }
            foreach ($it as $file) {
                if (microtime(true) > $deadline || count($files) >= SURICATEWEB_SCAN_MAX_PER_COMPONENT) {
                    $truncated = true;
                    break 2;
                }
                if (($file instanceof DirectoryIterator && $file->isDot()) || !$file->isFile() || $file->isLink()) {
                    continue;
                }
                if ($take($file->getFilename())) {
                    $files[] = $file->getPathname();
                }
            }
        } catch (Exception $e) {
            $truncated = true;
        }
    }
    sort($files);
    return array($files, $truncated);
}

/**
 * Analyse tous les composants et met l'inventaire à jour.
 *
 * @param array $components Liste de ['id' => texte, 'version' => texte, 'paths' => [...]] (voir suricateweb_scan_expand).
 * @param array $inventory  Inventaire précédent (tableau vide au tout premier relevé).
 * @param int   $now        Heure courante (secondes Unix).
 * @param float $deadline   Échéance (microtime) : au-delà, on s'arrête ; les composants non traités gardent leur état et
 *                          passent en premier au relevé suivant (le travail se répartit sur plusieurs relevés).
 * @param string $root      Racine du site, pour les chemins relatifs.
 * @return array{0:array,1:array} Rapport (à renvoyer) et inventaire à enregistrer.
 */
function suricateweb_scan_run($components, $inventory, $now, $deadline, $root)
{
    $prevAll = isset($inventory['c']) && is_array($inventory['c']) ? $inventory['c'] : array();
    $today = (int) floor($now / 86400);
    $partial = false;
    $total = 0;

    // Les composants les plus anciennement analysés d'abord (parcours circulaire quand le temps manque).
    usort($components, function ($a, $b) use ($prevAll) {
        $ta = isset($prevAll[$a['id']]['at']) ? (int) $prevAll[$a['id']]['at'] : 0;
        $tb = isset($prevAll[$b['id']]['at']) ? (int) $prevAll[$b['id']]['at'] : 0;
        return $ta <=> $tb;
    });

    $next = array();
    foreach ($components as $comp) {
        $id = $comp['id'];
        $prev = isset($prevAll[$id]) && is_array($prevAll[$id]) ? $prevAll[$id] : null;
        if (microtime(true) > $deadline) {
            $partial = true;
            if ($prev && isset($prev['f'])) {
                $next[$id] = $prev;
                $total += count($prev['f']);
            }
            continue;
        }
        list($files, $truncated) = suricateweb_scan_expand($comp, $deadline);
        $first = $prev === null;
        $updated = !$first && (string) (isset($prev['ver']) ? $prev['ver'] : '') !== (string) $comp['version'];
        $prevFiles = $prev && isset($prev['f']) && is_array($prev['f']) ? $prev['f'] : array();
        $entries = array();
        $aborted = false;
        foreach ($files as $abs) {
            if (microtime(true) > $deadline || $total + count($entries) >= SURICATEWEB_SCAN_MAX_TOTAL) {
                $aborted = true;
                break;
            }
            $size = @filesize($abs);
            if ($size === false || $size > SURICATEWEB_SCAN_MAX_FILE) {
                continue;
            }
            $hash = @sha1_file($abs);
            if ($hash === false) {
                continue;
            }
            $h = substr($hash, 0, 10);
            $rel = suricateweb_scan_rel($abs, $root);
            $old = isset($prevFiles[$rel]) && is_array($prevFiles[$rel]) ? $prevFiles[$rel] : null;
            if ($old && $old[0] === $h) {
                $entries[$rel] = $old; // inchangé : on garde son verdict et sa date
                continue;
            }
            $name = basename($abs);
            $text = suricateweb_scan_read($abs);
            list($lvl, $ids) = $text === null ? array('', array()) : suricateweb_scan_text($text, suricateweb_scan_is_config($name));
            // Apporté par la première analyse ou par une mise à jour de version : attendu ('b'). Sinon : un changement ('c').
            $entries[$rel] = array($h, $lvl, implode(',', $ids), ($first || $updated) ? 'b' : 'c', $today);
        }
        if ($aborted || $truncated) {
            $partial = true;
        }
        if ($aborted && $prev && isset($prev['f'])) {
            // Passage interrompu en cours de composant : on garde l'ancien état entier (jamais un inventaire à moitié mis à jour).
            $next[$id] = $prev;
            $total += count($prev['f']);
            continue;
        }
        $next[$id] = array('ver' => (string) $comp['version'], 'at' => $now, 'f' => $entries);
        $total += count($entries);
    }

    // Rapport : fichiers signalés (graves d'abord) et dérive récente.
    $order = array('s' => 0, 'r' => 1, 'v' => 2);
    $flagged = array();
    $drift = array();
    $inventoryCount = 0;
    foreach ($next as $comp) {
        foreach ($comp['f'] as $rel => $e) {
            $inventoryCount++;
            if ($e[1] !== '') {
                $flagged[] = array($rel, $e);
            } elseif ($e[3] === 'c' && isset($e[4]) && ($today - (int) $e[4]) <= SURICATEWEB_SCAN_DRIFT_DAYS) {
                $drift[] = $rel;
            }
        }
    }
    usort($flagged, function ($a, $b) use ($order) {
        $ka = $order[$a[1][1]] * 2 + ($a[1][3] === 'c' ? 0 : 1);
        $kb = $order[$b[1][1]] * 2 + ($b[1][3] === 'c' ? 0 : 1);
        return $ka <=> $kb ?: strcmp($a[0], $b[0]);
    });
    $names = array('s' => 'strong', 'r' => 'review', 'v' => 'vendor');
    $out = array();
    foreach (array_slice($flagged, 0, SURICATEWEB_SCAN_MAX_REPORTED) as $f) {
        $out[] = array(
            'path' => $f[0],
            'level' => $names[$f[1][1]],
            'hits' => $f[1][2] === '' ? array() : explode(',', $f[1][2]),
            'hash' => $f[1][0],
            'origin' => $f[1][3] === 'c' ? 'change' : 'baseline',
        );
    }
    sort($drift);
    $report = array(
        'enabled' => true,
        'files' => $out,
        'more' => max(0, count($flagged) - SURICATEWEB_SCAN_MAX_REPORTED),
        'drift' => array('files' => array_slice($drift, 0, 40), 'more' => max(0, count($drift) - 40), 'days' => SURICATEWEB_SCAN_DRIFT_DAYS),
        'inventory' => $inventoryCount,
        'baseline' => empty($prevAll),
        'partial' => $partial,
    );
    return array($report, array('v' => 1, 'c' => $next));
}
