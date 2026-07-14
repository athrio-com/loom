FROM oven/bun:1.2.20-alpine

WORKDIR /loom
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @athrio/loom-devtools build

WORKDIR /loom/packages/loom-devtools
ENV PORT=5710
EXPOSE 5710
CMD ["bun", "src/serve.ts"]
