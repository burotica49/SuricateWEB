// Adaptateur SQLite (node:sqlite) : la seule porte d'accès à la base pour src/db.js.
//
// Contrat commun à tous les moteurs (SQLite ici, PostgreSQL dans la version hébergée) :
//   - placeholders « ? » (l'adaptateur PostgreSQL les traduit en $1, $2…) ;
//   - les méthodes peuvent renvoyer une valeur ou une promesse : l'appelant écrit toujours `await` ;
//   - les nombres reviennent en `Number` (même pour COUNT, SUM, AVG et les horodatages en ms, que PostgreSQL
//     renvoie sinon en texte) ;
//   - SQL portable uniquement : pas de PRAGMA, de LIMIT -1, de COLLATE NOCASE, de MIN(a, b) à deux arguments.
//     Les écarts de dialecte se règlent ici, ou dans les migrations (une version par moteur).
//
//   all(sql, params)    → lignes
//   get(sql, params)    → première ligne, ou undefined
//   run(sql, params)    → { changes } (nombre de lignes touchées)
//   insert(sql, params) → identifiant créé. Le SQL est un INSERT ordinaire : PostgreSQL y ajoute « RETURNING id »,
//                         donc seulement pour les tables qui ont une colonne « id » (sinon, run).
//   exec(sql)           → exécute du SQL sans paramètres, plusieurs instructions admises (schéma, migrations)
//   transaction(fn)     → fn(tx) : validée si elle réussit, annulée si elle lève. `tx` est à utiliser pour tout
//                         ce qui doit être atomique (PostgreSQL y réserve une connexion). fn ne doit attendre
//                         que des requêtes de base : sous SQLite, une autre attente laisserait une requête
//                         concurrente s'intercaler dans la transaction.
//   close()
import { DatabaseSync } from 'node:sqlite';

/** Instructions préparées conservées : le SQL dynamique (IN (?,?…), filtres) ne doit pas faire grossir la mémoire sans fin. */
const CACHE_MAX = 300;

export function openSqlite(path) {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      if (cache.size >= CACHE_MAX) cache.clear();
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  const adapter = {
    dialect: 'sqlite',
    all: (sql, params = []) => stmt(sql).all(...params),
    get: (sql, params = []) => stmt(sql).get(...params),
    run: (sql, params = []) => ({ changes: Number(stmt(sql).run(...params).changes) }),
    insert: (sql, params = []) => Number(stmt(sql).run(...params).lastInsertRowid),
    exec: (sql) => raw.exec(sql),
    transaction(fn) {
      raw.exec('BEGIN');
      let out;
      try {
        out = fn(adapter);
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
      // fn asynchrone : la transaction se ferme quand sa promesse est réglée.
      if (out && typeof out.then === 'function') {
        return out.then(
          (v) => (raw.exec('COMMIT'), v),
          (e) => (raw.exec('ROLLBACK'), Promise.reject(e)),
        );
      }
      raw.exec('COMMIT');
      return out;
    },
    close: () => raw.close(),

    /**
     * Ancienne écriture `db.prepare(sql).get/all/run(...)`, gardée seulement pour les tests et scripts existants.
     * À ne pas utiliser dans le code de l'application ; retirée à l'étape du passage en asynchrone.
     */
    prepare: (sql) => stmt(sql),
  };
  return adapter;
}
