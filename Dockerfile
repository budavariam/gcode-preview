# Build stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Serve stage
FROM nginx:alpine
COPY --from=builder /app/demo /usr/share/nginx/html
COPY --from=builder /app/dist /usr/share/nginx/html/dist
COPY --from=builder /app/node_modules/three/build/three.module.min.js /usr/share/nginx/html/lib/three/build/three.module.min.js
COPY --from=builder /app/node_modules/three/build/three.core.min.js /usr/share/nginx/html/lib/three/build/three.core.min.js
COPY --from=builder /app/node_modules/lil-gui/dist/lil-gui.esm.min.js /usr/share/nginx/html/lib/lil-gui/dist/lil-gui.esm.min.js
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
