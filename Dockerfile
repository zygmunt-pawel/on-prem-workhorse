# syntax=docker/dockerfile:1

# ── Build stage ──────────────────────────────────────────────
FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Production stage ─────────────────────────────────────────
FROM node:22-slim

# Playwright Chromium system dependencies
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    libxshmfence1 \
    fonts-liberation \
    fonts-noto-color-emoji \
    dumb-init \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for security
RUN groupadd -r scraper && useradd -r -g scraper -m scraper

WORKDIR /app

# Production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Install Playwright Chromium browser
RUN npx playwright install chromium

# Copy compiled JS from build stage
COPY --from=build /app/dist ./dist

# Own everything by scraper user
RUN chown -R scraper:scraper /app

USER scraper

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

# dumb-init handles PID 1 and signal forwarding (graceful shutdown)
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
