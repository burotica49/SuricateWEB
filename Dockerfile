FROM node:24-alpine

LABEL org.opencontainers.image.title="SuricateWEB" \
      org.opencontainers.image.description="Surveillance de sites web avec alertes Telegram"

# Chromium : captures d'écran des sites. Polices : accents, emojis et caractères non latins s'affichent correctement.
# tini : Node tourne en PID 1 et ne récupère pas les processus orphelins ; sans lui, chaque capture laisserait des zombies.
RUN apk add --no-cache chromium font-noto font-noto-emoji tini su-exec

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    TRUST_PROXY=1 \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1

WORKDIR /app

# Aucune dépendance npm : on copie uniquement le code. Le fichier .env n'est jamais copié (voir .dockerignore) :
# les identifiants SURICATE_USER / SURICATE_PASSWORD se définissent dans les variables d'environnement de l'hébergeur.
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
# Plugins WordPress / PrestaShop : l'application les empaquette en ZIP à la demande (onglet Mises à jour).
COPY --chown=node:node plugins ./plugins

# Base SQLite et captures d'écran : à monter sur un volume persistant.
# Pas de USER ici : l'entrypoint démarre en root le temps de corriger le volume (souvent root:root),
# puis relance le processus en utilisateur node.
RUN mkdir -p /data && chown node:node /data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/auth').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
