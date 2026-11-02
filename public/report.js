// Bouton « Imprimer / PDF » du rapport mensuel (la page n'a pas de script en ligne : voir la politique de sécurité du contenu).
document.addEventListener('click', (e) => {
  if (e.target.closest?.('[data-print]')) window.print();
});
