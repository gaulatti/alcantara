# The return runner: Node with Playwright's own browsers, at the version the call checks use.
FROM mcr.microsoft.com/playwright:v1.65.0-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY runner.mjs ./
USER pwuser
CMD ["node", "runner.mjs"]
