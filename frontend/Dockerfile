# The production image (gaulatti/alcantara#741). It builds from the repository root, because the workspace lockfile
# lives there, and installs with --frozen-lockfile so it runs the versions CI tested.
FROM node:22.23.5-alpine AS production-dependencies-env
RUN npm install -g pnpm@9
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json frontend/
COPY backend/package.json backend/
COPY infra/aws/package.json infra/aws/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter frontend

FROM node:22.23.5-alpine AS build-env
RUN npm install -g pnpm@9
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json frontend/
COPY backend/package.json backend/
COPY infra/aws/package.json infra/aws/
RUN pnpm install --frozen-lockfile --filter frontend
COPY frontend/ ./frontend/
RUN pnpm --dir frontend run build

FROM node:22.23.5-alpine
WORKDIR /app/frontend
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=production-dependencies-env /app/frontend/node_modules /app/frontend/node_modules
COPY frontend/package.json frontend/serve.mjs ./
COPY --from=build-env /app/frontend/build /app/frontend/build
CMD ["npm", "run", "start"]
