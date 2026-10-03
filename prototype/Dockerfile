# KB Hub prototype: one container with the API, the web UI and the three schedulers.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# Hugging Face Spaces run the container as a non-root user: keep writable state under /tmp.
ENV PORT=7860 SIM_DIR=/tmp/sim-data DATA_DIR=/tmp/data HOME=/tmp NODE_ENV=production
EXPOSE 7860
CMD ["node", "src/server.js"]
