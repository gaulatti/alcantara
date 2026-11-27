FROM node:22.23.5-alpine AS builder

ARG ALCANTARA_BUILD_VERSION=dev

WORKDIR /app

RUN apk add --no-cache postgresql17-client ffmpeg \
    && pg_dump --version | grep -Eq ' 17\.'

# Install pnpm (v9 avoids interactive approve-builds flow in CI)
RUN npm install -g pnpm@9

# Trust Amazon RDS while retaining full certificate and hostname verification.
RUN mkdir -p /app/certs \
    && wget --quiet \
      --output-document=/app/certs/global-bundle.pem \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    && test -s /app/certs/global-bundle.pem

# Install exactly the workspace lockfile's versions (gaulatti/alcantara#581). The build context is the
# repository root, so pnpm-lock.yaml is present, and a lockfile out of step with a package.json fails the
# build instead of resolving newer versions than CI tested. The other workspace manifests are copied so
# the lockfile's importers match; only the backend's dependencies are installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY infra/aws/package.json infra/aws/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile --filter backend

# Copy app source and build
COPY backend/ backend/
WORKDIR /app/backend
RUN pnpm run prisma:generate
RUN pnpm run build
RUN test -f /app/backend/dist/src/proto/authorization.proto && test -f /app/backend/dist/src/proto/application_access.proto

ENV ALCANTARA_BUILD_VERSION=${ALCANTARA_BUILD_VERSION}

# The live backend migrates at start. A deploy candidate does not: deploy/cumulus.sh already ran the
# migration as its own step from this same image, and a second migration inside the candidate made one
# transient database error fail the whole deploy (gaulatti/alcantara#271).
CMD ["sh", "-c", "if [ -n \"$ALCANTARA_DEPLOY_CANDIDATE\" ]; then pnpm start:prod; else pnpm run db:migrate:deploy && pnpm start:prod; fi"]
