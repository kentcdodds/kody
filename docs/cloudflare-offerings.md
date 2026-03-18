# Cloudflare offerings (optional integrations)

kody ships with:

- D1 (`APP_DB`) for relational storage
- KV (`OAUTH_KV`) for OAuth/session state (owned by
  `@cloudflare/workers-oauth-provider`)
- Durable Objects (`MCP_OBJECT`) for MCP server state

This guide covers how to add common Cloudflare offerings on top of the starter:

- R2 (object storage)
- Workers AI
- AI Gateway
- An additional KV namespace for app data (separate from `OAUTH_KV`)

All examples assume you are using the template's `wrangler.jsonc` and that you
run commands from the repo root.

## Authentication: `wrangler login` vs API tokens

For local, interactive development:

- Log in once with `bunx wrangler login`
- Wrangler uses browser-based OAuth, and commands run as your user

For CI / GitHub Actions / automation:

- Create a Cloudflare API token and provide it as `CLOUDFLARE_API_TOKEN`
- Prefer least-privilege, account-scoped tokens (avoid "All accounts")

### What token to make (permissions)

Cloudflare's API token UI changes over time, but the shape is stable:

- Token permissions are **Account** permissions (not Zone permissions)
- You grant **Read**/**Edit** per product area
- Wrangler deploys, creates resources, and sets secrets via the API token

Recommended baseline permissions for this template (deploy + existing D1/KV):

- `Workers Scripts:Edit` (deploy, update, delete preview Workers)
- `Workers KV Storage:Edit` (OAuth/session KV)
- `D1:Edit` (migrations, database operations)

Add these permissions when you add the corresponding offering:

- R2: `R2 Storage:Edit`
- Workers AI: `Workers AI:Read` (for `wrangler ai models`; deploy still uses
  Workers Scripts)
- AI Gateway (only if you want to manage gateways via API): `AI Gateway:Edit`

If you use `bunx wrangler secret put ...` in CI, your token must also be able to
edit Worker secrets (covered by `Workers Scripts:Edit`).

## R2 (object storage)

Use R2 for file uploads, user-generated media, and other blob/object storage.

### Token permissions

- `R2 Storage:Edit` (for creating/listing buckets via Wrangler)

### Commands to create buckets

Create separate buckets for production vs preview/testing:

- `bunx wrangler r2 bucket create <app-name>-uploads`
- `bunx wrangler r2 bucket create <app-name>-uploads-preview`
- `bunx wrangler r2 bucket list`

Wrangler can also update `wrangler.jsonc` for you:

- `bunx wrangler r2 bucket create <app-name>-uploads --binding UPLOADS_BUCKET --env production --update-config`
- `bunx wrangler r2 bucket create <app-name>-uploads-preview --binding UPLOADS_BUCKET --env preview --update-config`

### Bind the bucket in `wrangler.jsonc`

Add an `r2_buckets` binding in each environment you want to use it:

- `env.production`: bind the production bucket
- `env.preview` / `env.test`: bind the preview bucket

Example (production):

```jsonc
"r2_buckets": [
  {
    "binding": "UPLOADS_BUCKET",
    "bucket_name": "<app-name>-uploads"
  }
],
```

Example (preview/test):

```jsonc
"r2_buckets": [
  {
    "binding": "UPLOADS_BUCKET",
    "bucket_name": "<app-name>-uploads-preview"
  }
],
```

### Local dev notes

`bun run dev` runs `wrangler dev --local`, so R2 is emulated locally. To hit
remote R2 from dev, run Wrangler with `--remote` (for example
`bun ./wrangler-env.ts dev --remote`).

## Workers AI

Workers AI lets your Worker call Cloudflare-hosted AI models.

### Token permissions

- `Workers Scripts:Edit` (deploy)
- `Workers AI:Read` (optional; for `wrangler ai models`)

### Commands to explore models

- `bunx wrangler ai models`
- `bunx wrangler ai models --json`

### Bind Workers AI in `wrangler.jsonc`

Add the AI binding per environment:

```jsonc
"ai": { "binding": "AI" }
```

If you want the `Ai` helper client, install it:

- `bun add @cloudflare/ai`

In your Worker code, you typically construct a client like:

```ts
import { Ai } from '@cloudflare/ai'

const ai = new Ai(env.AI)
```

## AI Gateway

AI Gateway provides analytics, caching, retries, and controls for calling
third-party AI providers (for example OpenAI or Anthropic) from your Worker.

### Token permissions

If you create/configure gateways via the dashboard, you do not need any extra
token permissions beyond what you already use to deploy Workers.

If you want to manage gateways via API automation, add:

- `AI Gateway:Edit`

### Create a gateway

There is no `wrangler` subcommand for AI Gateway in Wrangler v4. Create the
gateway in the Cloudflare dashboard:

1. Cloudflare dashboard -> `AI` -> `AI Gateway`
2. Create a gateway and copy:
   - your `account_id`
   - the `gateway_id` you chose/received

### Commands to verify the gateway works

AI Gateway uses provider-specific upstream paths. For OpenAI-compatible traffic,
the URL looks like:

`https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/openai`

You can do a quick smoke test with curl (example uses `OPENAI_API_KEY`):

- `curl -sS "https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/openai/v1/models" -H "Authorization: Bearer $OPENAI_API_KEY" | head`

### Using AI Gateway in app code

Most provider SDKs support overriding the base URL:

- Keep the provider API key as a Worker secret (for example `OPENAI_API_KEY`)
- Point the SDK's base URL at the gateway URL

For this starter's chat implementation, remote AI mode is expected to use a
gateway. Set `AI_GATEWAY_ID` in local `.env` when opting into `AI_MODE=remote`,
and configure GitHub Actions secrets so deploy workflows can sync it into the
worker secrets. Use `AI_GATEWAY_ID` for production deploys and
`AI_GATEWAY_ID_PREVIEW` for preview deploys if you want preview traffic routed
through a different gateway.

## KV (app KV, separate from `OAUTH_KV`)

This template already binds `OAUTH_KV` for OAuth/session state. Treat `OAUTH_KV`
as "owned" by `@cloudflare/workers-oauth-provider`:

- Avoid mixing app data into `OAUTH_KV`
- Avoid key prefix collisions with the OAuth library
- Keep quotas/evictions isolated from auth state

### Token permissions

- `Workers KV Storage:Edit`

### Commands to create a second namespace

Create a dedicated namespace for app data, for example `APP_KV`:

- `bunx wrangler kv namespace create <app-name>-app --binding APP_KV --env production --update-config`
- `bunx wrangler kv namespace create <app-name>-app-preview --binding APP_KV --env production --preview --update-config`

If you are not using `--update-config`, record the namespace IDs and add them to
`wrangler.jsonc` manually (see next section).

### Bind the namespace in `wrangler.jsonc`

Add a second entry in `kv_namespaces` alongside `OAUTH_KV`:

```jsonc
"kv_namespaces": [
  {
    "binding": "OAUTH_KV",
    "id": "<oauth-kv-id>",
    "preview_id": "<oauth-kv-preview-id>"
  },
  {
    "binding": "APP_KV",
    "id": "<app-kv-id>",
    "preview_id": "<app-kv-preview-id>"
  }
],
```

## If you want a higher-level AI integration

If you're looking for a higher-level way to integrate AI (streaming responses,
tool/function calling, typed outputs, and a clean client/server contract),
consider TanStack AI.

This starter is not a React app, so the main thing to know is: TanStack AI is
framework-agnostic at its core. You can use:

- `@tanstack/ai` on the server (Workers) to run models and tools
- `@tanstack/ai-client` in any UI (headless) to manage chat state + streaming

You only need the React/Solid packages if your UI framework benefits from their
hooks.

### Cloudflare integration: `@cloudflare/tanstack-ai`

Cloudflare maintains an official integration package that makes TanStack AI work
well with both:

- Workers AI (`env.AI` binding)
- AI Gateway (`env.AI.gateway("<gateway-id>")`)

It includes ready-to-use adapters for chat, image generation, transcription,
text-to-speech, and summarization for Workers AI models, plus AI Gateway routing
for OpenAI/Anthropic/Gemini/Grok/OpenRouter. See:

- https://github.com/cloudflare/ai/tree/main/packages/tanstack-ai

#### Install (Bun)

- `bun add @tanstack/ai @tanstack/ai-client @cloudflare/tanstack-ai`

If you want to route to third-party providers through AI Gateway, also install
the TanStack provider packages you use (for example OpenAI or Anthropic):

- `bun add @tanstack/ai-openai`
- `bun add @tanstack/ai-anthropic`

#### Bindings (`wrangler.jsonc`)

Add the Workers AI binding in each environment you want:

```jsonc
"ai": { "binding": "AI" }
```

Then your Worker receives `env.AI` at runtime.

#### Server-first usage (no React required)

TanStack AI supports multiple streaming formats. A common pattern is:

1. A Worker endpoint accepts `{ messages, conversationId? }` as JSON
2. Server runs `chat(...)` and returns a streaming `Response`
3. Your UI uses `@tanstack/ai-client` with either:
   - `fetchHttpStream("/api/chat")` (newline-delimited JSON), or
   - `fetchServerSentEvents("/api/chat")` (SSE)

Workers AI example (direct binding, no third-party API keys):

```ts
import { createWorkersAiChat } from '@cloudflare/tanstack-ai'
import { chat, toHttpResponse } from '@tanstack/ai'

const adapter = createWorkersAiChat('@cf/meta/llama-4-scout-17b-16e-instruct', {
	binding: env.AI,
})

const stream = chat({
	adapter,
	stream: true,
	messages,
	conversationId,
})

return toHttpResponse(stream)
```

AI Gateway example (route OpenAI requests through your gateway):

```ts
import { createOpenAiChat } from '@cloudflare/tanstack-ai'
import { chat, toHttpResponse } from '@tanstack/ai'

const adapter = createOpenAiChat('gpt-4o', {
	binding: env.AI.gateway('my-gateway-id'),
	// Depending on your gateway mode, you may not need to pass an API key here.
	// apiKey: env.OPENAI_API_KEY,
})

const stream = chat({ adapter, stream: true, messages, conversationId })
return toHttpResponse(stream)
```

Client usage (headless, works with any UI toolkit) looks like:

```ts
import { ChatClient, fetchHttpStream } from '@tanstack/ai-client'

const client = new ChatClient({
	connection: fetchHttpStream('/api/chat'),
	onMessagesChange: (next) => {
		// Render however your app renders (not tied to React)
		console.log(next)
	},
})
```
