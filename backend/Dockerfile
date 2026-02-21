FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Install dependencies
COPY package*.json ./
RUN pnpm install --no-frozen-lockfile

# Copy app source and build
COPY . .
RUN pnpm run build

CMD ["node", "dist/main"]