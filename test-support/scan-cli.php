<?php
// Banc d'essai du scanner de code suspect des plugins (plugins/*/suricateweb/scanner.php) : lit un JSON, répond en JSON.
//   php scan-cli.php <scanner.php> <entrée.json>
// Entrée « text »  : { "mode": "text", "cases": [ { "text": "...", "config": false } ] }
// Entrée « run »   : { "mode": "run", "components": [...], "inventory": {...}, "now": 1700000000, "root": "/dossier", "budget": 30 }
define('SURICATEWEB_SCANNER_TEST', true);
require $argv[1];
$in = json_decode(file_get_contents($argv[2]), true);
if ($in['mode'] === 'text') {
    $out = array();
    foreach ($in['cases'] as $c) {
        list($lvl, $ids) = suricateweb_scan_text($c['text'], !empty($c['config']));
        $out[] = array('level' => $lvl, 'hits' => $ids);
    }
    echo json_encode($out);
} else {
    $budget = isset($in['budget']) ? (float) $in['budget'] : 30;
    list($report, $inv) = suricateweb_scan_run($in['components'], $in['inventory'] ?: array(), $in['now'], microtime(true) + $budget, $in['root']);
    echo json_encode(array('report' => $report, 'inventory' => $inv), JSON_UNESCAPED_SLASHES);
}
