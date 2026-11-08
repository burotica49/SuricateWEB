// Liste ordonnée des migrations du cœur. Ajouter une migration = créer le fichier 000N-nom.js et l'inscrire ici.
// Les migrations d'une extension (src/store/registry.js) portent des numéros à partir de 1000 : jamais de collision avec le cœur.
import m0001 from './0001-initial.js';
import m0002 from './0002-accounts.js';

export const MIGRATIONS = [m0001, m0002];
