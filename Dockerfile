FROM node:22-bookworm-slim

# Install system Chromium and required dependencies for Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV CHROMIUM_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV RENDER=true

WORKDIR /app

# Copy dependency files
COPY package.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy app files
COPY . .

# Render exposes service on port 10000 by default (injected via PORT)
EXPOSE 10000

CMD ["node", "server.js"]
