# syntax=docker/dockerfile:1

# Base build stage - shared dependencies
FROM node:18-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm install

# Development stage - with hot reload
FROM base AS dev
COPY . .
RUN apk add --no-cache inotify-tools
EXPOSE 80
CMD ["npm", "run", "dev"]

# Production build stage
FROM base AS builder
COPY . .
RUN npm run build

# Production serve stage - nginx
FROM nginx:alpine AS prod
COPY --from=builder /app/demo /usr/share/nginx/html
COPY --from=builder /app/dist /usr/share/nginx/html/dist
COPY --from=builder /app/node_modules/three/build/three.module.min.js /usr/share/nginx/html/lib/three/build/three.module.min.js
COPY --from=builder /app/node_modules/three/build/three.core.min.js /usr/share/nginx/html/lib/three/build/three.core.min.js
COPY --from=builder /app/node_modules/lil-gui/dist/lil-gui.esm.min.js /usr/share/nginx/html/lib/lil-gui/dist/lil-gui.esm.min.js
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
