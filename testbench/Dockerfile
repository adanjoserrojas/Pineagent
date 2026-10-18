FROM node:22.18.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.163.0
WORKDIR /opt/harness
COPY harness/package.json harness/package-lock.json ./
RUN npm ci --ignore-scripts --workspaces=false
COPY harness/src ./src
COPY harness/test ./test
COPY harness/tsconfig.json ./
RUN npm run build
WORKDIR /opt/bench
COPY src/common.mjs src/metrics.mjs src/worker.mjs ./
RUN mkdir -p /work /input && chown node:node /work /input
USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/bench/worker.mjs"]
