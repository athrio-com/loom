FROM oven/bun:1.2.20-alpine

WORKDIR /loom
COPY . .
RUN bun install --frozen-lockfile

WORKDIR /loom/site
RUN bunx --bun vite build

ENV PORT=4321
EXPOSE 4321
CMD ["bun", "src/server/server.ts"]
