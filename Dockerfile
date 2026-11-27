FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev

ENTRYPOINT ["node", "build/index.js"]
