# One image for both services: `web` (Next.js) and `worker` (persistent jobs).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
RUN useradd -m app && mkdir -p /app/data && chown -R app /app
COPY --from=build --chown=app /app ./
USER app
EXPOSE 3000
# Default: web. The worker service overrides the command with `npm run worker`.
CMD ["npm", "run", "start"]
