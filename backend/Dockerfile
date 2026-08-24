FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm (v9 avoids interactive approve-builds flow in CI)
RUN npm install -g pnpm@9

# Install dependencies
COPY package*.json ./
RUN pnpm install --no-frozen-lockfile

# Copy app source and build
COPY . .
RUN pnpm run prisma:generate
RUN pnpm run build
RUN test -f /app/dist/src/proto/authorization.proto

CMD ["sh", "-c", "pnpm run db:migrate:deploy && pnpm start:prod"]
