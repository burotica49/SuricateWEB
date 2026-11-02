import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const dockerignore = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());

// L'application lit ces dossiers à l'exécution (plugins/ : ZIP des plugins WordPress / PrestaShop servis à la demande).
test('image Docker : embarque le code et les plugins, sans les scripts de démo ni les tests', () => {
  for (const dir of ['src', 'public', 'plugins']) {
    assert.match(dockerfile, new RegExp(`^COPY .*\\b${dir} \\./${dir}\\s*$`, 'm'), `${dir}/ est copié dans l'image`);
    assert.equal(dockerignore.includes(dir), false, `${dir}/ n'est pas exclu du contexte de build`);
  }
  for (const dir of ['test', 'test-support', 'scripts', 'docs']) assert.ok(dockerignore.includes(dir), `${dir}/ est exclu du contexte`);
});
