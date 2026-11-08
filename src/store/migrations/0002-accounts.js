// Migration 2 : comptes. Chaque site et chaque groupe appartient à un compte (account_id).
//
// Le cœur n'a qu'un compte, « implicite » (identifiant 1) : toutes les lignes existantes y sont rattachées par la valeur par
// défaut, sans aucune perte. Le reste (contrôles, alertes, captures, versions, pannes, maintenances) dépend du site, donc du
// compte, sans colonne supplémentaire. Il n'y a pas de table « accounts » ici : la version hébergée crée la sienne
// (migration d'extension) et y fait pointer ces identifiants.
const sqlite = (db) =>
  db.exec(`
    ALTER TABLE watches ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE site_groups ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1;
    CREATE INDEX IF NOT EXISTS idx_watches_account ON watches(account_id, position);
    CREATE INDEX IF NOT EXISTS idx_groups_account ON site_groups(account_id, position);
  `);

const postgres = (db) =>
  db.exec(`
    ALTER TABLE watches ADD COLUMN account_id BIGINT NOT NULL DEFAULT 1;
    ALTER TABLE site_groups ADD COLUMN account_id BIGINT NOT NULL DEFAULT 1;
    CREATE INDEX IF NOT EXISTS idx_watches_account ON watches(account_id, position);
    CREATE INDEX IF NOT EXISTS idx_groups_account ON site_groups(account_id, position);
  `);

export default { version: 2, name: 'accounts', sqlite, postgres };
