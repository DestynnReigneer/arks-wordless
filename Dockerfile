# syntax=docker/dockerfile:1

FROM node:26-alpine

# Tini reaps zombies and forwards signals, so `docker compose stop` actually
# stops the process instead of waiting out the 10s kill timeout.
RUN apk add --no-cache tini wget

WORKDIR /app

# Dependencies first, so editing game code doesn't re-run npm on every build.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY db.js server.js ./
COPY rambler ./rambler
COPY words ./words
COPY public ./public

# The SQLite file is the only state. It lives on a mounted volume, so the
# directory has to exist and be owned by the unprivileged user before we drop
# to it -- a root-owned /app/data would leave the app unable to write.
RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node

# Reports unhealthy if the word lists failed to load, not merely if the port
# is open -- a listening process with no dictionary is the failure that would
# otherwise look fine from outside.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
