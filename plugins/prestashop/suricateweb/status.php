<?php
/**
 * Point d'accès lu par SuricateWEB. Hors du contrôleur front : le mode maintenance
 * de PrestaShop ne le bloque pas, et les URL réécrites ne sont pas nécessaires.
 * Ne renvoie rien sans le jeton configuré dans le module.
 */
@ini_set('display_errors', '0');
ob_start();
require_once dirname(dirname(__DIR__)) . '/config/config.inc.php';
ob_end_clean();

header('Content-Type: application/json; charset=utf-8');
header('X-Robots-Tag: noindex, nofollow');
header('Cache-Control: no-store');

$module = Module::getInstanceByName('suricateweb');
if (!$module || !Module::isEnabled('suricateweb')) {
    http_response_code(404);
    echo '{"error":"inactive"}';
    exit;
}
$module->emitStatus();
