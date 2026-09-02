FROM node:22-alpine AS builder

ARG ALCANTARA_BUILD_VERSION=dev

WORKDIR /app

# Install pnpm (v9 avoids interactive approve-builds flow in CI)
RUN npm install -g pnpm@9

# Trust Amazon RDS while retaining full certificate and hostname verification.
RUN mkdir -p /app/certs \
    && wget --quiet \
      --output-document=/app/certs/global-bundle.pem \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    && test -s /app/certs/global-bundle.pem

# Install dependencies
COPY package*.json ./
RUN pnpm install --no-frozen-lockfile

# Copy app source and build
COPY . .
RUN pnpm run prisma:generate
RUN pnpm run build
RUN test -f /app/dist/src/proto/authorization.proto

ENV ALCANTARA_BUILD_VERSION=${ALCANTARA_BUILD_VERSION}

CMD ["sh", "-c", "pnpm run db:migrate:deploy && pnpm start:prod"]
