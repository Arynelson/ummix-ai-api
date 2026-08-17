FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
COPY contracts/package.json ./contracts/package.json
RUN npm ci

COPY contracts ./contracts
COPY src ./src
COPY migrations ./migrations
COPY tsconfig.json ./tsconfig.json
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
COPY contracts/package.json ./contracts/package.json
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations

USER node
EXPOSE 10000
CMD ["sh", "-c", "node dist/db/migrate.js up && exec node dist/server.js"]
