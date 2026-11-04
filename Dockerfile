# Production image for the API. Also runs the one-off scripts in dist/scripts (migrate, seed, storage-to-disk).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
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
# Migrations run first, so a failed migration stops this version from starting. Coolify's pre-deployment command is
# skipped on the first deploy, and a failed post-deployment command still counts as success. exec passes on SIGTERM.
CMD ["sh", "-c", "node dist/scripts/migrate.js && exec node dist/server.js"]
