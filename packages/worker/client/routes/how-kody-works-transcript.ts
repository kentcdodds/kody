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

const whatShippedSource = `import { packageStorage } from 'kody:runtime'

const login = 'kody-bot'
const seenKey = 'lastSeenEventId'

export default async function whatShipped() {
	const storage = packageStorage()
	const sinceId = (await storage.get(seenKey)) as string | null
	const shipped = await listShipped(sinceId)
	if (shipped[0]) await storage.set(seenKey, shipped[0].id)
	return shipped.length === 0
		? { shipped, message: 'Nothing new.' }
		: { shipped, message: shipped.map((item) => item.title).join('\\n') }
}

async function listShipped(sinceId: string | null) {
	const response = await fetch(
		\`https://api.github.com/users/\${login}/events/public\`,
		{
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: 'Bearer {{secret:githubAccessToken}}',
				'X-GitHub-Api-Version': '2022-11-28',
			},
		},
	)
	if (!response.ok) throw new Error(\`GitHub \${response.status}\`)
	const events = (await response.json()) as Array<{
		id: string
		type: string
		repo: { name: string }
		payload: {
			action?: string
			ref_type?: string
			release?: { tag_name?: string }
		}
	}>
	const shipped = []
	for (const event of events) {
		if (sinceId && event.id === sinceId) break
		if (
			event.type === 'ReleaseEvent' &&
			event.payload.action === 'published'
		) {
			shipped.push({
				id: event.id,
				kind: 'release',
				title: \`\${event.repo.name} \${event.payload.release?.tag_name ?? 'release'}\`,
			})
		}
		if (
			event.type === 'CreateEvent' &&
			event.payload.ref_type === 'repository'
		) {
			shipped.push({
				id: event.id,
				kind: 'repository',
				title: \`New repo \${event.repo.name}\`,
			})
		}
	}
	return shipped
}
`

const dailyDigestSource = `import { kody } from 'kody:runtime'
import whatShipped from './what-shipped.ts'

export default async function dailyDigest() {
	const result = await whatShipped()
	if (result.shipped.length === 0) return { emailed: false }
	await kody.email_send({
		subject:
			result.shipped.length === 1
				? 'kody-bot shipped something'
				: \`kody-bot shipped \${result.shipped.length} things\`,
		text: result.message,
	})
	return { emailed: true, count: result.shipped.length }
}
`

const readmeAskOnly = `# kody-bot-shipped

## Intent

Tell me what kody-bot shipped — published releases and new public repos —
since I last asked.
`

const readmeWithMail = `# kody-bot-shipped

## Intent

Tell me what kody-bot shipped — published releases and new public repos —
since I last asked. Email me only when that list is not empty.
`

const packageJsonAskOnly = `{
  "name": "@you/kody-bot-shipped",
  "private": true,
  "exports": {
    "./whatShipped": "./src/what-shipped.ts"
  },
  "kody": {
    "id": "kody-bot-shipped",
    "description": "What kody-bot shipped since you last asked."
  }
}`

function packageJsonWithJob(enabled: boolean) {
	return `{
  "name": "@you/kody-bot-shipped",
  "private": true,
  "exports": {
    "./whatShipped": "./src/what-shipped.ts",
    "./daily-digest": "./src/daily-digest.ts"
  },
  "kody": {
    "id": "kody-bot-shipped",
    "description": "What kody-bot shipped since you last asked.",
    "jobs": {
      "daily-digest": {
        "entry": "./src/daily-digest.ts",
        "schedule": { "type": "cron", "expression": "0 8 * * *" },
        "timezone": "America/Denver",
        "enabled": ${enabled}
      }
    }
  }
}`
}

export const howKodyWorksPackageFiles = {
	'package.json': packageJsonWithJob(true),
	'README.md': readmeWithMail,
	'src/what-shipped.ts': whatShippedSource,
	'src/daily-digest.ts': dailyDigestSource,
} as const

const fetchShipsCode = `export default async function main() {
	const response = await fetch(
		'https://api.github.com/users/kody-bot/events/public',
		{
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: 'Bearer {{secret:githubAccessToken}}',
				'X-GitHub-Api-Version': '2022-11-28',
			},
		},
	)
	if (!response.ok) throw new Error(\`GitHub \${response.status}\`)
	const events = await response.json()
	return events.flatMap((event) => {
		if (
			event.type === 'ReleaseEvent' &&
			event.payload.action === 'published'
		) {
			return [{
				id: event.id,
				kind: 'release',
				title: \`\${event.repo.name} \${event.payload.release.tag_name}\`,
			}]
		}
		if (
			event.type === 'CreateEvent' &&
			event.payload.ref_type === 'repository'
		) {
			return [{
				id: event.id,
				kind: 'repository',
				title: \`New repo \${event.repo.name}\`,
			}]
		}
		return []
	})
}`

const invokeWhatShippedCode = `import whatShipped from 'kody:@you/kody-bot-shipped/whatShipped'

export default async function main() {
	return await whatShipped()
}`

const invokeDailyDigestCode = `import dailyDigest from 'kody:@you/kody-bot-shipped/daily-digest'

export default async function main() {
	return await dailyDigest()
}`

const loadGuidesCode = `import { kody } from 'kody:runtime'

export default async function main() {
	const authoring = await kody.coding_guide_get({
		guide: 'package_authoring',
	})
	const lifecycle = await kody.coding_guide_get({
		guide: 'package_lifecycle',
	})
	return { authoring, lifecycle }
}`

const loadLifecycleCode = `import { kody } from 'kody:runtime'

export default async function main() {
	return await kody.coding_guide_get({
		guide: 'package_lifecycle',
	})
}`

function asEmbeddedTemplateLiteral(value: string) {
	return `\`${value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${')}\``
}

const getGitRemoteCreateCode = `import { kody } from 'kody:runtime'

export default async function main() {
	return await kody.package_get_git_remote({
		kody_id: 'kody-bot-shipped',
		create: true,
		description: 'What kody-bot shipped since you last asked.',
	})
}`

const publishExternalPushCode = `import { kody } from 'kody:runtime'

export default async function main() {
	return await kody.package_publish_external_push({
		kody_id: 'kody-bot-shipped',
	})
}`

const artifactsRemote =
	'https://acct.artifacts.cloudflare.net/git/default/package-pkg_kody_bot_shipped.git'

const gitAuthor = {
	name: 'You',
	email: 'you@example.com',
}

const redactedBearer = 'Authorization: Bearer [REDACTED SECRET]'

function gitRemoteCreateReturn() {
	return {
		package_id: 'pkg_kody_bot_shipped',
		kody_id: 'kody-bot-shipped',
		created: true,
		remote: artifactsRemote,
		authenticated_remote: '[REDACTED SECRET]',
		git_extra_header: '[REDACTED SECRET]',
		scope: 'write',
		expires_at: '2026-08-13T18:52:00.000Z',
		git_author: gitAuthor,
		setup_commands: [
			`git -c http.extraHeader='${redactedBearer}' clone '${artifactsRemote}' 'pkg_kody_bot_shipped'`,
			`cd 'pkg_kody_bot_shipped'`,
			`git config --local user.email -- '${gitAuthor.email}'`,
			`git config --local user.name -- '${gitAuthor.name}'`,
			`git remote add kody '${artifactsRemote}'`,
			`git config remote.kody.fetch '+refs/heads/*:refs/remotes/kody/*'`,
			`git config --add remote.kody.fetch '+refs/notes/*:refs/notes/*'`,
			`git -c http.extraHeader='${redactedBearer}' fetch kody 'refs/notes/*:refs/notes/*'`,
			`git -c http.extraHeader='${redactedBearer}' push kody HEAD:'main'`,
		],
	}
}

function publishReturn(input: {
	publishedCommit: string
	previousCommit: string | null
	manifest: unknown
}) {
	return {
		status: 'published',
		previous_commit: input.previousCommit,
		published_commit: input.publishedCommit,
		manifest: input.manifest,
		checks: [{ kind: 'manifest', ok: true, message: 'ok' }],
		hosted_app_url: null,
		static_dependents: { total: 0, items: [] },
		pending_secret_package_approvals: null,
	}
}

const askMemoryContext = {
	task: 'What did my favorite bot ship recently on GitHub?',
	entities: ['favorite bot'],
}

const phoneMemoryContext = {
	task: 'Anything interesting shipped by my favorite bot recently?',
	entities: ['favorite bot'],
}

const notifyMemoryContext = {
	task: 'Update me when kody-bot does something.',
	entities: ['kody-bot'],
}

const watchLoginMemory = {
	subject: 'Favorite bot',
	summary:
		"kody-bot is my favorite bot. I'm really interested in what it ships on github",
}

const askConversationId = '3k7n2p9q4r8w'
const phoneConversationId = '5h8m2q7t1v4x'
const repoSessionId = 'rs_kody_bot_shipped'

const addDailyJobSessionCode = `import { kody } from 'kody:runtime'

const dailyDigest = ${asEmbeddedTemplateLiteral(dailyDigestSource)}

export default async function main() {
	const session = await kody.repo_open_session({
		target: { kind: 'package', kody_id: 'kody-bot-shipped' },
		conversation_id: '${phoneConversationId}',
	})
	await kody.repo_write_file({
		session_id: session.id,
		files: [{ path: 'src/daily-digest.ts', content: dailyDigest }],
	})
	await kody.repo_edit_files({
		session_id: session.id,
		edits: [
			{
				kind: 'replace',
				path: 'package.json',
				search: '    "./whatShipped": "./src/what-shipped.ts"',
				replacement:
					'    "./whatShipped": "./src/what-shipped.ts",\\n    "./daily-digest": "./src/daily-digest.ts"',
			},
			{
				kind: 'replace',
				path: 'package.json',
				search: '    "description": "What kody-bot shipped since you last asked."',
				replacement: ${asEmbeddedTemplateLiteral(`    "description": "What kody-bot shipped since you last asked.",
    "jobs": {
      "daily-digest": {
        "entry": "./src/daily-digest.ts",
        "schedule": { "type": "cron", "expression": "0 8 * * *" },
        "timezone": "America/Denver",
        "enabled": false
      }
    }`)},
			},
			{
				kind: 'replace',
				path: 'README.md',
				search: 'since I last asked.',
				replacement:
					'since I last asked. Email me only when that list is not empty.',
			},
		],
	})
	await kody.repo_commit({
		session_id: session.id,
		message: 'Add a quiet daily digest job',
	})
	const checks = await kody.repo_run_checks({ session_id: session.id })
	const published = await kody.repo_publish_session({
		session_id: session.id,
	})
	return { session_id: session.id, checks, published }
}`

const enableDailyJobSessionCode = `import { kody } from 'kody:runtime'

export default async function main() {
	const session = await kody.repo_open_session({
		target: { kind: 'package', kody_id: 'kody-bot-shipped' },
		conversation_id: '${phoneConversationId}',
	})
	await kody.repo_edit_files({
		session_id: session.id,
		edits: [
			{
				kind: 'replace',
				path: 'package.json',
				search: '"enabled": false',
				replacement: '"enabled": true',
			},
		],
	})
	await kody.repo_commit({
		session_id: session.id,
		message: 'Enable the daily digest job',
	})
	const checks = await kody.repo_run_checks({ session_id: session.id })
	const published = await kody.repo_publish_session({
		session_id: session.id,
	})
	return { session_id: session.id, checks, published }
}`

function repoSessionPublishReturn(publishedCommit: string) {
	return {
		session_id: repoSessionId,
		checks: {
			ok: true,
			results: [
				{ kind: 'manifest', ok: true, message: 'ok' },
				{ kind: 'typecheck', ok: true, message: 'ok' },
			],
			manifest: {
				name: '@you/kody-bot-shipped',
				kody_id: 'kody-bot-shipped',
				description: 'What kody-bot shipped since you last asked.',
				has_app: false,
			},
		},
		published: {
			status: 'ok',
			session_id: repoSessionId,
			published_commit: publishedCommit,
			message: 'Published session to main.',
		},
	}
}

const githubSearchMarkdown = `# Search results

For full detail on entity-backed hits, call \`search\` with \`entity: "{id}:{type}"\`.

1. **secret** \`githubAccessToken\` — github OAuth access token. Entity: \`githubAccessToken:secret\``

const codingGuideSearchMarkdown = `# Search results

For full detail on entity-backed hits, call \`search\` with \`entity: "{id}:{type}"\`.

1. **capability** \`coding_guide_get\` (\`coding\`) — Load an official Kody guide (markdown, bundled from the kody repository). Prefer this capability plus \`search\` results over local repo spelunking when Kody auth or integration behavior is already documented. Entity: \`coding_guide_get:capability\`
   \`kody.coding_guide_get(args)\` — \`type CodingGuideGetInput = { guide: "what_is_kody" | "quick_example" | "first_win" | "package_authoring" | "package_lifecycle" | ... }\`; use entity detail for the full definition`

const codingGuideDetailMarkdown = `# Capability — \`coding_guide_get\`

Load an official Kody guide (markdown, bundled from the kody repository).
Use \`guide: "package_authoring"\` for package creation or material package updates.
Use \`guide: "package_lifecycle"\` to choose reuse vs a new durable package, and before enabling package-owned schedules.

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

const packageSearchMarkdown = `# Search results

For full detail on entity-backed hits, call \`search\` with \`entity: "{id}:{type}"\`.

1. **package** @you/kody-bot-shipped (\`kody-bot-shipped\`) — What kody-bot shipped since you last asked. Entity: \`kody-bot-shipped:package\``

const notifySearchMarkdown = `# Search results

For full detail on entity-backed hits, call \`search\` with \`entity: "{id}:{type}"\`.

1. **capability** \`coding_guide_get\` (\`coding\`) — Load an official Kody guide (markdown, bundled from the kody repository). Use \`guide: "package_lifecycle"\` before enabling a package-owned schedule. Entity: \`coding_guide_get:capability\`
2. **capability** \`webhook_url_mint\` (\`webhooks\`) — Mint an inbound webhook URL for a package-declared webhook. Entity: \`webhook_url_mint:capability\`
3. **capability** \`job_schedule\` (\`jobs\`) — Schedule a repo-backed job without creating a saved package first. Entity: \`job_schedule:capability\``

export const howKodyWorksTranscriptActs: Array<TranscriptAct> = [
	{
		id: 'ask',
		kicker: 'Example of a conversation you might have with your agent.',
		title: 'Ask once',
		lines: [
			{
				role: 'user',
				text: 'What did my favorite bot ship recently on GitHub?',
			},
			{
				role: 'agent',
				tone: 'reasoning',
				text: 'I will look up GitHub user activity and any memory that names your favorite bot.',
			},
			{
				role: 'tools',
				tools: [
					{
						name: 'search',
						summary: 'Find a saved GitHub token for user activity',
						note: 'Search returns secret metadata, never the token. The memory names kody-bot as the favorite bot. The `conversationId` is minted here so later calls in this chat stay cheap.',
						inputs: [
							{
								name: 'query',
								kind: 'query',
								lang: 'json',
								value: jsonInput('github user activity'),
							},
							memoryContextInput(askMemoryContext),
						],
						resultLang: 'md',
						result: searchTextReturn({
							conversationId: askConversationId,
							body: githubSearchMarkdown,
							memories: [watchLoginMemory],
						}),
					},
				],
			},
			{
				role: 'agent',
				tone: 'reasoning',
				text: 'Favorite bot is kody-bot. I will fetch public events with the saved token.',
			},
			{
				role: 'tools',
				tools: [
					{
						name: 'execute',
						summary:
							'Fetch public events with the saved token and keep only real ships',
						note: 'The module never sees the token. `Authorization` gets a secret placeholder, filled in only for approved hosts. The kody-bot memory already surfaced on search, so execute does not repeat it.',
						inputs: [
							{
								name: 'code',
								kind: 'code',
								lang: 'ts',
								value: fetchShipsCode,
							},
							conversationIdInput(askConversationId),
							memoryContextInput(askMemoryContext),
						],
						resultLang: 'md',
						result: executeTextReturn({
							conversationId: askConversationId,
							value: [
								{
									id: '51284920123',
									kind: 'release',
									title: 'kody-bot/lantern v1.4.0',
								},
								{
									id: '51279004401',
									kind: 'repository',
									title: 'New repo kody-bot/quiet-days',
								},
							],
						}),
					},
				],
			},
			{
				role: 'agent',
				text: 'Two things since the last look: kody-bot/lantern v1.4.0, and a new public repo kody-bot/quiet-days. Want this as a package so I can get you the answer quicker next time?',
			},
			{
				role: 'user',
				text: 'Yes',
			},
			{
				role: 'agent',
				tone: 'reasoning',
				text: 'I will load the package authoring guides, then save the filter as an export you own.',
			},
			{
				role: 'tools',
				tools: [
					{
						name: 'search',
						summary: 'Find the official package authoring guides',
						note: '`domain: "coding"` ranks official guides. That is how the agent finds `coding_guide_get` instead of inventing a package shape.',
						inputs: [
							{
								name: 'query',
								kind: 'query',
								lang: 'json',
								value: jsonInput('package authoring lifecycle'),
							},
							{
								name: 'domain',
								kind: 'query',
								lang: 'json',
								value: jsonInput('coding'),
							},
							conversationIdInput(askConversationId),
						],
						resultLang: 'md',
						result: searchTextReturn({
							conversationId: askConversationId,
							body: codingGuideSearchMarkdown,
						}),
					},
					{
						name: 'search',
						summary: 'Open coding_guide_get for the guide ids',
						note: 'Entity detail is the full card. It names `package_authoring` and `package_lifecycle` — the two guides this package needs.',
						inputs: [
							{
								name: 'entity',
								kind: 'query',
								lang: 'json',
								value: jsonInput('coding_guide_get:capability'),
							},
							conversationIdInput(askConversationId),
						],
						resultLang: 'md',
						result: searchTextReturn({
							conversationId: askConversationId,
							body: codingGuideDetailMarkdown,
						}),
					},
					{
						name: 'execute',
						summary: 'Load the package authoring and lifecycle guides',
						note: 'Guides are bundled markdown from the Kody repo. The real `coding_guide_get` return is the full guide (a couple hundred lines each). This walkthrough shows the opening only.',
						inputs: [
							{
								name: 'code',
								kind: 'code',
								lang: 'ts',
								value: loadGuidesCode,
							},
							conversationIdInput(askConversationId),
							memoryContextInput(askMemoryContext),
						],
						resultLang: 'md',
						result: executeTextReturn({
							conversationId: askConversationId,
							value: {
								authoring: {
									title: 'Package authoring guide',
									body: '# Package authoring guide\n\nUse this guide when creating a new Kody package or materially changing an existing one.\n\n## Choose an authoring lane\n\n…',
								},
								lifecycle: {
									title: 'Durable package lifecycle guide',
									body: '# Durable package lifecycle\n\nUse this guide to decide whether to reuse existing behavior, explore with `execute`, or create durable repo-backed package code. Use it before scheduling new package behavior.\n\n## Choose the smallest durable surface\n\n…',
								},
							},
						}),
					},
				],
			},
			{
				role: 'agent',
				tone: 'reasoning',
				text: 'The authoring guide prefers the git lane. I will register a stub, clone it, write the export, push, and publish.',
			},
			{
				role: 'tools',
				tools: [
					{
						name: 'execute',
						summary: 'Register the stub and mint a clone remote',
						note: '`create: true` registers a stub saved package and mints a short-lived remote. `setup_commands` clone into a temporary directory and set `git_author` from the signed-in account. Token-bearing fields come back redacted.',
						inputs: [
							{
								name: 'code',
								kind: 'code',
								lang: 'ts',
								value: getGitRemoteCreateCode,
							},
							conversationIdInput(askConversationId),
							memoryContextInput(askMemoryContext),
						],
						resultLang: 'md',
						result: executeTextReturn({
							conversationId: askConversationId,
							value: gitRemoteCreateReturn(),
						}),
					},
				],
			},
			{
				role: 'files',
				summary: 'Write the export in the temporary clone',
				note: 'Written in the clone, then committed with `git_author` — never a guessed identity — and pushed with the last setup command.',
				files: [
					{
						path: 'package.json',
						summary: 'Export only — no job yet',
						lang: 'json',
						content: packageJsonAskOnly,
					},
					{
						path: 'README.md',
						summary: 'Why this package exists',
						lang: 'md',
						content: readmeAskOnly,
					},
					{
						path: 'src/what-shipped.ts',
						summary: 'Filter public events and advance the cursor',
						lang: 'ts',
						content: whatShippedSource,
					},
				],
			},
			{
				role: 'tools',
				tools: [
					{
						name: 'execute',
						summary: 'Publish Artifacts HEAD as the owned package',
						note: 'Publish reads the pushed HEAD. The export is now invocable from any agent. No job yet — that waits until you ask to be notified.',
						inputs: [
							{
								name: 'code',
								kind: 'code',
								lang: 'ts',
								value: publishExternalPushCode,
							},
							conversationIdInput(askConversationId),
							memoryContextInput(askMemoryContext),
						],
						resultLang: 'md',
						result: executeTextReturn({
							conversationId: askConversationId,
							value: publishReturn({
								previousCommit: '4c1a0e8b2d91',
								publishedCommit: '7f3a91c2e8b4',
								manifest: JSON.parse(packageJsonAskOnly),
							}),
						}),
					},
				],
			},
			{
				role: 'agent',
				text: 'You now have `kody-bot-shipped`. Ask again from any agent and I will invoke the export instead of walking GitHub by hand.',
			},
		],
	},
	{
		id: 'invoke',
		kicker:
			'Later, on your phone with a completely different Kody-connected agent',
		title: 'Ask again. Now safer, cheaper, and more reliable.',
		lines: [
			{
				role: 'user',
				text: 'Anything interesting shipped by my favorite bot recently?',
			},
			{
				role: 'agent',
				tone: 'reasoning',
				text: 'Same question in different words. I will search for a package that already answers this.',
			},
			{
				role: 'tools',
				tools: [
					{
						name: 'search',
						summary: 'Find the owned package, not a new GitHub walk',
						note: 'A new conversation, and a new wording. Search still finds the owned package instead of walking GitHub again, and the kody-bot memory surfaces once more.',
						inputs: [
							{
								name: 'query',
								kind: 'query',
								lang: 'json',
								value: jsonInput('anything interesting shipped favorite bot'),
							},
							memoryContextInput(phoneMemoryContext),
						],
						resultLang: 'md',
						result: searchTextReturn({
							conversationId: phoneConversationId,
							body: packageSearchMarkdown,
							memories: [watchLoginMemory],
						}),
					},
					{
						name: 'execute',
						summary: 'Invoke the export — no model rewriting the filter',
						note: 'A static `kody:@` import calls the export as written. No model rewrites the filter. The memory already surfaced on search in this new conversation.',
						inputs: [
							{
								name: 'code',
								kind: 'code',
								lang: 'ts',
								value: invokeWhatShippedCode,
							},
							conversationIdInput(phoneConversationId),
							memoryContextInput(phoneMemoryContext),
						],
						resultLang: 'md',
						result: executeTextReturn({
							conversationId: phoneConversationId,
							value: {
								shipped: [],
								message: 'Nothing new.',
							},
						}),
					},
				],
			},
			{
				role: 'agent',
				text: 'Nothing interesting has shipped.',
			},
			{
				role: 'user',
				text: 'Update me when kody-bot does something.',
			},
			{
				role: 'agent',
				tone: 'reasoning',
				text: 'I will search for how to notify you when this package has something new.',
			},
			{
				role: 'tools',
				tools: [
					{
						name: 'search',
						summary: 'Find how to notify when the export has news',
						note: 'Same phone conversation, new task. Search ranks the lifecycle guide, inbound webhooks, and ad hoc `job_schedule`. The kody-bot memory already surfaced earlier in this chat.',
						inputs: [
							{
								name: 'query',
								kind: 'query',
								lang: 'json',
								value: jsonInput('notify when github user ships'),
							},
							conversationIdInput(phoneConversationId),
							memoryContextInput(notifyMemoryContext),
						],
						resultLang: 'md',
						result: searchTextReturn({
							conversationId: phoneConversationId,
							body: notifySearchMarkdown,
						}),
					},
					{
						name: 'execute',
						summary: 'Load the package lifecycle guide',
						note: 'The real `coding_guide_get` return is the full guide. This walkthrough shows the opening only. It is how the agent learns to add a package-owned job, test the wrapper, then enable it.',
						inputs: [
							{
								name: 'code',
								kind: 'code',
								lang: 'ts',
								value: loadLifecycleCode,
							},
							conversationIdInput(phoneConversationId),
							memoryContextInput(notifyMemoryContext),
						],
						resultLang: 'md',
						result: executeTextReturn({
							conversationId: phoneConversationId,
							value: {
								title: 'Durable package lifecycle guide',
								body: '# Durable package lifecycle\n\nUse this guide to decide whether to reuse existing behavior, explore with `execute`, or create durable repo-backed package code. Use it before scheduling new package behavior.\n\n## Choose the smallest durable surface\n\n…',
							},
						}),
					},
				],
			},
			{
				role: 'agent',
				tone: 'reasoning',
				text: 'Inbound webhooks are URLs I host, not a GitHub feed of one person’s public activity. `job_schedule` is for jobs without a package. I will open a repo session, patch in a daily cron wrapper, test it, then enable the job.',
			},
			{
				role: 'tools',
				tools: [
					{
						name: 'execute',
						summary: 'Patch the package in a repo session, job left off',
						note: '`package_save` would replace every file. A repo session writes the new wrapper and `replace`s only the changed lines in `package.json` and `README.md`. The job stays off until the wrapper has been invoked once.',
						inputs: [
							{
								name: 'code',
								kind: 'code',
								lang: 'ts',
								value: addDailyJobSessionCode,
							},
							conversationIdInput(phoneConversationId),
							memoryContextInput(notifyMemoryContext),
						],
						resultLang: 'md',
						result: executeTextReturn({
							conversationId: phoneConversationId,
							value: repoSessionPublishReturn('c8e2b1a04f73'),
						}),
					},
					{
						name: 'execute',
						summary: 'Test the no-argument wrapper the scheduler will call',
						note: 'The wrapper takes no arguments so a cron can call it. `shipped` is empty, so `emailed` is false — quiet on purpose.',
						inputs: [
							{
								name: 'code',
								kind: 'code',
								lang: 'ts',
								value: invokeDailyDigestCode,
							},
							conversationIdInput(phoneConversationId),
							memoryContextInput(notifyMemoryContext),
						],
						resultLang: 'md',
						result: executeTextReturn({
							conversationId: phoneConversationId,
							value: { emailed: false },
						}),
					},
					{
						name: 'execute',
						summary: 'Enable the daily job after the wrapper succeeds',
						note: 'One `replace` flips `"enabled"` after the wrapper has been invoked once. After this, mornings are a job, not a prompt.',
						inputs: [
							{
								name: 'code',
								kind: 'code',
								lang: 'ts',
								value: enableDailyJobSessionCode,
							},
							conversationIdInput(phoneConversationId),
							memoryContextInput(notifyMemoryContext),
						],
						resultLang: 'md',
						result: executeTextReturn({
							conversationId: phoneConversationId,
							value: repoSessionPublishReturn('e1d9c70b3a26'),
						}),
					},
				],
			},
			{
				role: 'agent',
				text: 'It will check every morning. If kody-bot shipped something, you get mail. If not, nothing hits your inbox.',
			},
		],
	},
]
