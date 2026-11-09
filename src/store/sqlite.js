// Adaptateur SQLite (node:sqlite) : la seule porte d'accès à la base pour src/db.js.
//
// Contrat commun à tous les moteurs (SQLite ici, PostgreSQL dans la version hébergée) :
//   - placeholders « ? » (l'adaptateur PostgreSQL les traduit en $1, $2…) ;
//   - les méthodes peuvent renvoyer une valeur ou une promesse : l'appelant écrit toujours `await` ;
//   - les nombres reviennent en `Number` (même pour COUNT, SUM, AVG et les horodatages en ms, que PostgreSQL
//     renvoie sinon en texte) ;
//   - SQL portable uniquement : pas de PRAGMA, de LIMIT -1, de COLLATE NOCASE, de MIN(a, b) à deux arguments ; un alias en
//     camelCase s'écrit entre guillemets (AS "finalUrl"), car PostgreSQL passe les noms non cités en minuscules.
//     test/sql-portable.test.js interdit ces constructions.
//     Les écarts de dialecte se règlent ici, ou dans les migrations (une version par moteur).
//
//   all(sql, params)    → lignes
//   get(sql, params)    → première ligne, ou undefined
//   run(sql, params)    → { changes } (nombre de lignes touchées)
//   insert(sql, params) → identifiant créé. Le SQL est un INSERT ordinaire : PostgreSQL y ajoute « RETURNING id »,
//                         donc seulement pour les tables qui ont une colonne « id » (sinon, run).
//   exec(sql)           → exécute du SQL sans paramètres, plusieurs instructions admises (schéma, migrations)
//   transaction(fn)     → fn(tx), toujours asynchrone : validée si elle réussit, annulée si elle lève. `tx` est à
//                         utiliser pour tout ce qui doit être atomique (PostgreSQL y réserve une connexion).
//                         fn ne doit attendre que des requêtes de base. Sous SQLite (une seule connexion), les
//                         transactions passent l'une après l'autre, mais une requête hors transaction peut
//                         s'intercaler pendant les attentes : n'y mettre que ce qui ne s'annule pas pour une raison
//                         métier (valider AVANT d'ouvrir la transaction).
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

  let txTail = Promise.resolve();

  const adapter = {
    dialect: 'sqlite',
    all: (sql, params = []) => stmt(sql).all(...params),
    get: (sql, params = []) => stmt(sql).get(...params),
    run: (sql, params = []) => ({ changes: Number(stmt(sql).run(...params).changes) }),
    insert: (sql, params = []) => Number(stmt(sql).run(...params).lastInsertRowid),
    exec: (sql) => raw.exec(sql),
    // Une transaction à la fois : la fonction attend ses requêtes, et un second BEGIN lancé pendant ces attentes échouerait.
    transaction(fn) {
      const run = txTail.then(async () => {
        raw.exec('BEGIN');
        try {
          const out = await fn(adapter);
          raw.exec('COMMIT');
          return out;
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        }
      });
      txTail = run.then(() => {}, () => {}); // l'échec d'une transaction ne bloque pas la suivante
      return run;
    },
    close: () => raw.close(),
  };
  return adapter;
}
