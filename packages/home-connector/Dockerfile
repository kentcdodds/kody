FROM node:24-alpine AS deps

WORKDIR /app

ARG APP_COMMIT_SHA=unknown

COPY . .

RUN npm ci --omit=dev

FROM node:24-alpine

WORKDIR /app

COPY --from=deps /app /app

WORKDIR /app/packages/home-connector

ENV NODE_ENV=production
ENV PORT=4040
ENV APP_COMMIT_SHA=${APP_COMMIT_SHA}
ENV SENTRY_ENVIRONMENT=production
ENV SENTRY_TRACES_SAMPLE_RATE=1.0

EXPOSE 4040

CMD ["node", "index.ts"]
