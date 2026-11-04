# Production image for the API. Also runs the one-off scripts in dist/scripts (migrate, seed, storage-to-disk).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --include=dev keeps the compiler even if NODE_ENV=production reaches this stage as a build argument.
RUN npm ci --include=dev
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY assets ./assets
# Created here so the named volumes mounted over them are writable by the node user.
RUN mkdir -p uploads private-uploads && chown node:node uploads private-uploads
USER node
EXPOSE 4000
# This image has no curl or wget, which Coolify's dashboard health check needs. Coolify uses this one instead.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Migrations run first, so a failed migration stops this version from starting. Coolify's pre-deployment command is
# skipped on the first deploy, and a failed post-deployment command still counts as success. exec passes on SIGTERM.
CMD ["sh", "-c", "node dist/scripts/migrate.js && exec node dist/server.js"]
