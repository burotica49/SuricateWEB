import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Garde de portabilité : le SQL du cœur doit tourner tel quel sur SQLite ET sur PostgreSQL (version hébergée). On ne peut pas
// lancer PostgreSQL ici (le cœur n'a aucune dépendance), alors on interdit par analyse les constructions SQLite-seulement qui
// ont déjà causé des erreurs ou qui sont connues pour en causer. Les exceptions légitimes sont dans les migrations (un code par
// moteur) et dans l'adaptateur SQLite lui-même.
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXEMPT = ['src/store/sqlite.js', 'src/store/migrations/'];

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
  });
}

const RULES = [
  [/\bAS +[a-z]+[A-Z]\w*/g, 'alias en camelCase sans guillemets : PostgreSQL le passe en minuscules (écrire AS "finalUrl")'],
  [/\bPRAGMA\b/g, 'PRAGMA n\'existe pas sur PostgreSQL (le réglage va dans l\'adaptateur)'],
  [/\bLIMIT +-1\b/g, 'LIMIT -1 n\'existe pas sur PostgreSQL (utiliser LIMIT 1000000000)'],
  [/\bCOLLATE +NOCASE\b/gi, 'COLLATE NOCASE n\'existe pas sur PostgreSQL (utiliser LOWER())'],
  [/\bINSERT +OR +(IGNORE|REPLACE)\b/gi, 'INSERT OR IGNORE/REPLACE n\'existe pas sur PostgreSQL (utiliser ON CONFLICT)'],
  [/\b(IFNULL|GROUP_CONCAT|STRFTIME|DATETIME|RANDOMBLOB|TYPEOF)\s*\(/gi, 'fonction SQLite seulement'],
  [/\bAUTOINCREMENT\b/gi, 'AUTOINCREMENT n\'existe pas sur PostgreSQL (dans une migration, par moteur)'],
  [/\bIS +NOT +\?/g, '« IS NOT ? » : comparer avec IS NOT DISTINCT FROM / IS DISTINCT FROM'],
];

for (const [re, why] of RULES) {
  test(`SQL portable : ${why}`, () => {
    const bad = [];
    for (const f of files(SRC)) {
      const rel = relative(ROOT, f);
      if (EXEMPT.some((e) => rel.startsWith(e))) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        // Seules les lignes de SQL comptent : un commentaire qui parle de PRAGMA ne casse rien.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        re.lastIndex = 0;
        if (re.test(line)) bad.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
    }
    assert.deepEqual(bad, [], why);
  });
}
