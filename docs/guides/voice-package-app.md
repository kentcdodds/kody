# Voice package app starter

Use this guide when building a Kody-authenticated package app for browser voice
calls without using Kody's `agent_turn_*` primitives.

## Current implementation boundary

The starter package lives in
[`docs/examples/voice-call-app`](../examples/voice-call-app/).

It intentionally separates what works in Kody package apps today from the later
Cloudflare Voice binding work:

- package app route and auth are handled by Kody
- UI is responsive, accessible, and supports light/dark mode
- the "thinking" state plays a short pending sound
- `/api/chat` uses an AI SDK tool loop and calls Kody capabilities through
  `codemode`
- no Kody agent-turn capability is required
- live Cloudflare Voice transport is left behind a clear runtime boundary until
  package apps expose the needed Workers AI and voice/Agent bindings

## Save the starter package

Save every file from `docs/examples/voice-call-app` as the package source:

- `package.json`
- `app.ts`
- `readme.md`

Then open the app with the MCP `open_generated_ui` tool using
`{ "kody_id": "voice-call-app" }`.

## Runtime behavior

The app serves three paths:

- `/` renders the voice console
- `/api/status` reports whether Workers AI is available
- `/api/chat` runs the text fallback model/tool loop when `env.AI` is available

The UI uses a typed utterance as the transcript source until the Cloudflare
Voice transport can be attached. That keeps the app testable while preserving
the intended flow:

1. user starts a call
2. user speaks or types an utterance
3. UI enters `thinking`
4. pending sound loops while the model/tool loop runs
5. response is streamed into the transcript
6. later Cloudflare Voice TTS can replace text playback

## Tool-loop pattern

Keep tool calls local to the package app's model request:

```ts
const { codemode } = await import('kody:runtime')

const result = streamText({
	model: workersAi('@cf/moonshotai/kimi-k2.6'),
	tools: {
		list_kody_capabilities: tool({
			inputSchema: z.object({}),
			execute: async () => {
				const capabilities = await codemode.meta_list_capabilities({})
				return Array.isArray(capabilities) ? capabilities.slice(0, 8) : []
			},
		}),
	},
})
```

This is deliberately different from `agent_turn_start` / `agent_turn_next`. The
package app owns the model call, tool definitions, status UI, and audio
feedback.

## Later voice binding work

When Kody exposes the needed bindings to package app workers, wire the existing
UI to Cloudflare Voice:

- use `@cloudflare/voice` for browser WebSocket audio, STT, TTS, interruption,
  and call status
- use Workers AI STT/TTS providers such as `WorkersAIFluxSTT` and `WorkersAITTS`
- keep `streamText({ tools })` inside `onTurn` so tool calls continue to use the
  package-local AI SDK loop
- keep the client-side pending sound tied to `status === "thinking"`

Do not reintroduce Kody agent-turn primitives for this app.
