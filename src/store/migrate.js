// Migrations de schéma numérotées, communes à tous les moteurs.
//
// Une migration = { version, name, sqlite(db), postgres(db) } : une fonction par moteur, car le DDL diffère
// (AUTOINCREMENT / identité, BLOB / BYTEA, entiers 64 bits). Elles s'appliquent dans l'ordre des versions, chacune dans sa
// transaction, et ne s'exécutent qu'une fois : la table « schema_migrations » garde la trace de celles déjà passées.
//
// Règles : une migration publiée ne change plus (on en ajoute une nouvelle) ; elle doit être écrite pour les DEUX moteurs.
import { MIGRATIONS } from './migrations/index.js';

export async function migrate(db, migrations = MIGRATIONS) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)');
  const done = new Set((await db.all('SELECT version FROM schema_migrations')).map((r) => r.version));

  const versions = migrations.map((m) => m.version);
  if (new Set(versions).size !== versions.length) throw new Error('Migrations : numéro de version en double');

  const applied = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    const up = m[db.dialect];
    if (typeof up !== 'function') throw new Error(`Migration ${m.version} (${m.name}) : pas de version « ${db.dialect} »`);
    await db.transaction(async (tx) => {
      await up(tx);
      await tx.run('INSERT INTO schema_migrations(version, name, applied_at) VALUES(?,?,?)', [m.version, m.name, Date.now()]);
    });
    applied.push(m.version);
  }
  return applied;
}
