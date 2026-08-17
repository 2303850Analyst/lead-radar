# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ENV NODE_ENV=production
RUN npm run build

FROM build AS production-dependencies

RUN npm prune --omit=dev

FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--max-old-space-size=160

RUN addgroup -S leadradar && adduser -S leadradar -G leadradar

COPY --from=build --chown=leadradar:leadradar /app/dist ./dist
COPY --from=production-dependencies --chown=leadradar:leadradar /app/node_modules ./node_modules
COPY --chown=leadradar:leadradar docker/server.mjs ./docker/server.mjs

USER leadradar

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/search').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "docker/server.mjs"]
