FROM oven/bun:1.3.11-alpine

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile --production

WORKDIR /app/packages/home-connector

ENV NODE_ENV=production
ENV PORT=4040

EXPOSE 4040

CMD ["bun", "run", "start"]
