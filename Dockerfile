FROM node:24-alpine

LABEL org.opencontainers.image.title="VigieWeb" \
      org.opencontainers.image.description="Surveillance de sites web avec alertes Telegram"

# Chromium : captures d'écran des sites. Polices : accents, emojis et caractères non latins s'affichent correctement.
# tini : Node tourne en PID 1 et ne récupère pas les processus orphelins ; sans lui, chaque capture laisserait des zombies.
RUN apk add --no-cache chromium font-noto font-noto-emoji tini

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    TRUST_PROXY=1 \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1

WORKDIR /app

# Aucune dépendance npm : on copie uniquement le code. Le fichier .env n'est jamais copié (voir .dockerignore) :
# les identifiants VIGIE_USER / VIGIE_PASSWORD se définissent dans les variables d'environnement de l'hébergeur.
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# Base SQLite et captures d'écran : à monter sur un volume persistant.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/auth').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
