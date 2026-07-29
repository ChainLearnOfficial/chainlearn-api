FROM node:22-alpine AS base
# Install tini for proper PID 1 signal handling and zombie reaping
RUN apk add --no-cache tini
WORKDIR /app

FROM base AS deps
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS build-deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS build
COPY --from=build-deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS production
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
