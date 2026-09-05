# Node 24 runtime digest already validated by the sandbox contract.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY src ./src
COPY web ./web
COPY prompts ./prompts
COPY scripts/build.mjs ./scripts/build.mjs
COPY tsconfig.json ./
RUN node scripts/build.mjs

FROM node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS dependencies
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN bun install --production --frozen-lockfile --ignore-scripts && npm rebuild better-sqlite3

FROM node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE SPR_SKILL_AUTHORING.md README.md ./
COPY docs/tr ./docs/tr
COPY scripts/container-health.mjs ./scripts/container-health.mjs
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
ENV SKILL_FORGE_DATA_DIR=/data SKILL_FORGE_PORT=38475
VOLUME ["/data"]
EXPOSE 38475
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["node", "scripts/container-health.mjs"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
