# Puppeteer base image ships a matching Chromium — no manual browser setup needed.
FROM ghcr.io/puppeteer/puppeteer:22.15.0

WORKDIR /home/pptruser/app

COPY --chown=pptruser:pptruser package*.json ./
RUN npm install --omit=dev

COPY --chown=pptruser:pptruser . .

# Render provides PORT at runtime
CMD ["node", "server.js"]
