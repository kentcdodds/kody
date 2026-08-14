import {
	conversationIdInput,
	executeTextReturn,
	jsonInput,
	memoryContextInput,
	searchTextReturn,
	type TranscriptAct,
} from './interactive-guide-transcript.ts'

export type {
	TranscriptAct,
	TranscriptFile,
	TranscriptInput,
	TranscriptLine,
	TranscriptTool,
} from './interactive-guide-transcript.ts'

const conversationId = '8g4q1n6m2s9t'

const askMemoryContext = {
	task: 'Connect Google so Kody can read my Gmail inbox for Acme invoices',
	entities: ['Google', 'Gmail', 'Acme invoices'],
}

const loadGuidesCode = `import { kody } from 'kody:runtime'

export default async function main() {
	const bootstrap = await kody.coding_guide_get({
		guide: 'integration_bootstrap',
	})
	const oauth = await kody.coding_guide_get({ guide: 'oauth' })
	const google = await kody.coding_guide_get({ guide: 'provider_google' })
	return { bootstrap, oauth, google }
}`

const gmailProfileSmokeCode = `import { createAuthenticatedFetch } from 'kody:runtime'

export default async function main() {
	const googleFetch = await createAuthenticatedFetch('google')
	const response = await googleFetch(
		'https://gmail.googleapis.com/gmail/v1/users/me/profile',
	)
	if (!response.ok) {
		throw new Error(
			\`Gmail smoke test failed: \${response.status} \${await response.text()}\`,
		)
	}
	return await response.json()
}`

const recentSubjectsCode = `import { createAuthenticatedFetch } from 'kody:runtime'

export default async function main() {
	const googleFetch = await createAuthenticatedFetch('google')
	const listResponse = await googleFetch(
		'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=2',
	)
	if (!listResponse.ok) {
		throw new Error(\`Gmail list failed: \${listResponse.status}\`)
	}
	const list = (await listResponse.json()) as {
		messages?: Array<{ id: string }>
	}
	const subjects: Array<string> = []
	for (const message of list.messages ?? []) {
		const detailResponse = await googleFetch(
			\`https://gmail.googleapis.com/gmail/v1/users/me/messages/\${message.id}?format=metadata&metadataHeaders=Subject\`,
		)
		if (!detailResponse.ok) continue
		const detail = (await detailResponse.json()) as {
			payload?: { headers?: Array<{ name: string; value: string }> }
		}
		const subject = detail.payload?.headers?.find(
			(header) => header.name.toLowerCase() === 'subject',
		)?.value
		if (subject) subjects.push(subject)
	}
	return { subjects }
}`

const gmailReadonlyScope = 'https://www.googleapis.com/auth/gmail.readonly'

const connectOauthUrl =
	'https://kody.codes/connect/oauth?provider=google&authorizeUrl=https%3A%2F%2Faccounts.google.com%2Fo%2Foauth2%2Fv2%2Fauth&tokenUrl=https%3A%2F%2Foauth2.googleapis.com%2Ftoken&flow=confidential&scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly&allowedHosts=gmail.googleapis.com&extraAuthorizeParams=%7B%22access_type%22%3A%22offline%22%2C%22prompt%22%3A%22consent%22%7D'

const codingGuideSearchMarkdown = `# Search results

For full detail on entity-backed hits, call \`search\` with \`entity: "{id}:{type}"\`.

1. **capability** \`coding_guide_get\` (\`coding\`) — Load an official Kody guide (markdown, bundled from the kody repository). Prefer this capability plus \`search\` results over local repo spelunking when Kody auth or integration behavior is already documented. Entity: \`coding_guide_get:capability\`
   \`kody.coding_guide_get(args)\` — \`type CodingGuideGetInput = { guide: "integration_bootstrap" | "oauth" | "provider_google" | ... }\`; use entity detail for the full definition
2. **guide** Connect Google (Gmail, Calendar, Drive) — Built-in Calendar scopes vs bring-your-own OAuth for inbox reading. Entity: \`provider_google:guide\`
3. **guide** OAuth guide (standard path) — Hosted \`/connect/oauth\`, redirect URI, PKCE vs confidential. Entity: \`oauth:guide\``

const codingGuideDetailMarkdown = `# Capability — \`coding_guide_get\`

Load an official Kody guide (markdown, bundled from the kody repository).
Use \`guide: "integration_bootstrap"\` before building anything that depends on third-party auth.
Use \`guide: "oauth"\` for the hosted \`/connect/oauth\` path and redirect URI.
Use \`guide: "provider_google"\` for Google console steps, built-in vs BYO lanes, and the Testing-status refresh-token trap.

## Summary

- Entity: \`coding_guide_get:capability\`
- Domain: \`coding\`
- Required input fields: \`guide\`

## Execute from \`execute\`

\`\`\`ts
import { kody } from 'kody:runtime'

export default async function main(input = {}) {
	return await kody.coding_guide_get(input)
}
\`\`\`
`

export const googleOauthTranscriptActs: Array<TranscriptAct> = [
	{
		id: 'discover',
		kicker: 'Example of a conversation you might have with your agent.',
		title: 'Find the path',
		lines: [
			{
				role: 'user',
				text: 'I want Kody to read my Gmail inbox for invoices from Acme. I have no idea how to connect Google — can you walk me through it?',
			},
			{
				role: 'agent',
				tone: 'reasoning',
				text: 'I do not already know the Google connect steps. I will search for official Kody guides on Google, Gmail, and OAuth.',
			},
			{
				role: 'tools',
				tools: [
					{
						name: 'search',
						summary: 'Find official guides for Google Gmail OAuth',
						note: 'Search ranks `coding_guide_get` and the Google / OAuth guides. No matching memory is required for this story. The `conversationId` is minted here so later calls in this chat stay cheap.',
						inputs: [
							{
								name: 'query',
								kind: 'query',
								lang: 'json',
								value: jsonInput('google gmail inbox oauth'),
							},
							memoryContextInput(askMemoryContext),
						],
						resultLang: 'md',
						result: searchTextReturn({
							conversationId,
							body: codingGuideSearchMarkdown,
						}),
					},
					{
						name: 'search',
						summary: 'Open coding_guide_get for the guide ids',
						note: 'Entity detail is the full card. It names `integration_bootstrap`, `oauth`, and `provider_google` — the three guides this connect needs.',
						inputs: [
							{
								name: 'entity',
								kind: 'query',
								lang: 'json',
								value: jsonInput('coding_guide_get:capability'),
							},
							conversationIdInput(conversationId),
						],
						resultLang: 'md',
						result: searchTextReturn({
							conversationId,
							body: codingGuideDetailMarkdown,
						}),
					},
					{
						name: 'execute',
						summary: 'Load bootstrap, OAuth, and Google provider guides',
						note: 'Guides are bundled markdown from the Kody repo. The real `coding_guide_get` return is the full guide (a couple hundred lines each). This walkthrough shows the opening only.',
						inputs: [
							{
								name: 'code',
								kind: 'code',
								lang: 'ts',
								value: loadGuidesCode,
							},
							conversationIdInput(conversationId),
							memoryContextInput(askMemoryContext),
						],
						resultLang: 'md',
						result: executeTextReturn({
							conversationId,
							value: {
								bootstrap: {
									title: 'Integration bootstrap guide',
									body: '# Integration bootstrap guide\n\nRead this guide first when a user wants a package, package app, or workflow that depends on a third-party integration.\n\n## Core rule\n\nDo not save or present an auth-dependent package as complete until a minimal authenticated smoke test succeeds.\n\n…',
								},
								oauth: {
									title: 'OAuth guide (standard path)',
									body: '# OAuth guide\n\nSend the signed-in user to `https://kody.codes/connect/oauth` with query parameters that describe the provider.\n\n## Redirect URI\n\nThe redirect URI is `https://kody.codes/connect/oauth`.\n\n…',
								},
								google: {
									title: 'Connect Google (Gmail, Calendar, Drive)',
									body: '# Connect Google (Gmail, Calendar, Drive)\n\nPrefer the built-in Google integration when its scope menu covers the task. Bring your own Google OAuth client when you need access outside that menu — especially inbox reading.\n\n## Lane A: built-in Google (default)\n\n…\n\n## Lane B: bring-your-own OAuth client\n\n…',
								},
							},
						}),
					},
				],
			},
			{
				role: 'agent',
				tone: 'reasoning',
				text: 'Inbox reading (`gmail.readonly`) is outside the built-in Google scope menu. That means Lane B: bring-your-own OAuth client in Google Cloud, not the one-click `/connect/oauth?provider=google` path.',
			},
			{
				role: 'agent',
				text: 'Reading your Gmail inbox needs a Google Cloud OAuth client you own — the built-in Google connect only covers scopes like Calendar and send-only Gmail, not inbox reading. I will walk you through the console one step at a time. Open https://console.cloud.google.com and create a new project (or select one you already use). Reply when that is done.',
			},
		],
	},
	{
		id: 'console',
		kicker: 'Same conversation — one console step at a time',
		title: 'Build the OAuth client',
		lines: [
			{
				role: 'user',
				text: 'I created a project. What is next?',
			},
			{
				role: 'agent',
				text: 'In `APIs & Services → Library`, enable `Gmail API` for that project. Skip Calendar and Drive unless you need them for this task. Reply when Gmail API shows as enabled.',
			},
			{
				role: 'user',
				text: 'Done, what is next?',
			},
			{
				role: 'agent',
				text: 'Open `APIs & Services → Google Auth Platform` and click `Get started`. Fill in `Branding` (app name and support email), set `Audience` to `External`, and add your contact email. Reply when the wizard finishes.',
			},
			{
				role: 'user',
				text: 'Done.',
			},
			{
				role: 'agent',
				text: 'On the `Clients` tab, click `Create Client`, choose application type `Web application`, and add this redirect URI exactly: `https://kody.codes/connect/oauth`. Copy the client ID and client secret when Google shows them — you will paste those into Kody later, not here.',
			},
			{
				role: 'user',
				text: 'What is a redirect URI? And is it okay if I paste the client secret here so you can save it?',
			},
			{
				role: 'agent',
				text: 'A redirect URI is the URL the provider sends the browser back to after you approve access. For Kody it is always `https://kody.codes/connect/oauth` — register it exactly, no trailing slash. Do not paste the client secret in chat. When we get to the connect form, paste the client ID and client secret only on that Kody page.',
			},
			{
				role: 'user',
				text: 'Okay, client is created. Next?',
			},
			{
				role: 'agent',
				text: `On the \`Data Access\` tab, add this scope: \`${gmailReadonlyScope}\`. That is the inbox-read scope this invoice task needs.`,
			},
			{
				role: 'user',
				text: 'Added. Done, what is next?',
			},
			{
				role: 'agent',
				text: 'While publishing status is `Testing`, open the `Audience` tab and add your own Google account as a test user. Reply when you are listed.',
			},
			{
				role: 'user',
				text: 'I am a test user. Can we connect now? It already works in Testing.',
			},
			{
				role: 'agent',
				text: 'Almost — but stay on `Testing` and refresh tokens expire after seven days. Everything looks fine during setup, then the integration dies a week later with `invalid_grant` on refresh. On the `Audience` page, click `Publish app` to move to `Production`. Google shows an “unverified app” warning on consent; for a personal app that is expected — click Advanced, then continue to your app when you authorize. Reply when status is Production.',
			},
			{
				role: 'user',
				text: 'Published. Ready for the Kody side.',
			},
		],
	},
	{
		id: 'connect',
		kicker: 'Same conversation — connect on Kody, then prove it',
		title: 'Connect and verify',
		lines: [
			{
				role: 'agent',
				text: `Open this prefilled connect link while signed in to Kody:\n\n${connectOauthUrl}\n\nPaste the client ID and client secret into that form (confidential flow). Authorize Google when prompted. The link already requests \`gmail.readonly\`, allows \`gmail.googleapis.com\`, and sets \`access_type=offline\` with \`prompt=consent\` so you get a refresh token.`,
			},
			{
				role: 'user',
				text: 'Here is my client secret — can I paste it here so you finish setup?',
			},
			{
				role: 'agent',
				text: 'No — never paste a client secret into chat. Delete that message if you can. Paste the client ID and client secret only on the Kody `/connect/oauth` form I linked, then authorize in the browser.',
			},
			{
				role: 'user',
				text: 'I authorized. What is next?',
			},
			{
				role: 'agent',
				tone: 'reasoning',
				text: 'I will smoke-test the Gmail profile endpoint with the saved Google integration before we call this done.',
			},
			{
				role: 'tools',
				tools: [
					{
						name: 'execute',
						summary: 'Smoke-test Gmail with the saved Google integration',
						note: '`createAuthenticatedFetch` refreshes tokens host-side. The module never sees a raw access token. Profile URL comes from the Google provider guide.',
						inputs: [
							{
								name: 'code',
								kind: 'code',
								lang: 'ts',
								value: gmailProfileSmokeCode,
							},
							conversationIdInput(conversationId),
							memoryContextInput(askMemoryContext),
						],
						resultLang: 'md',
						result: executeTextReturn({
							conversationId,
							value: {
								emailAddress: 'you@example.com',
								messagesTotal: 1842,
								threadsTotal: 921,
								historyId: '123456',
							},
						}),
					},
					{
						name: 'execute',
						summary: 'List a couple of recent message subjects',
						note: 'Optional second check after profile succeeds. Still no package — the payoff is a working integration.',
						inputs: [
							{
								name: 'code',
								kind: 'code',
								lang: 'ts',
								value: recentSubjectsCode,
							},
							conversationIdInput(conversationId),
							memoryContextInput(askMemoryContext),
						],
						resultLang: 'md',
						result: executeTextReturn({
							conversationId,
							value: {
								subjects: ['Acme Invoice #4412', 'Your weekly digest'],
							},
						}),
					},
				],
			},
			{
				role: 'agent',
				text: 'Connected. Your Gmail profile loads, and recent mail includes an Acme invoice subject. Later reconnects can use `/connect/oauth?provider=google` alone — Kody already has the endpoints from this setup.',
			},
		],
	},
]
