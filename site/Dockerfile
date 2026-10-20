FROM oven/bun:1.2.20-alpine

WORKDIR /loom
COPY . .
RUN bun install --frozen-lockfile

WORKDIR /loom/site
RUN bun run weave:source && bun run colour:source
RUN bunx --bun vite build && bun src/render-ahead.ts

ENV PORT=4321
EXPOSE 4321
CMD ["bun", "--smol", "src/server.ts"]
