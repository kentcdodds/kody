import { z } from 'zod'
import { defineDomainCapability } from '../define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { type CapabilityContext } from '../types.ts'

/** Same upper bound as markdown doc fetches elsewhere. */
const MAX_GUIDE_BODY_CHARS = 2_000_000

export const KODY_GUIDES_REPO = {
	owner: 'kentcdodds',
	repo: 'kody',
	ref: 'main',
	basePath: 'docs/guides',
} as const

export type KodyOfficialGuideId = keyof typeof kodyOfficialGuideCatalog

export const kodyOfficialGuideCatalog = {
	integration_bootstrap: {
		file: 'integration-bootstrap.md',
		title: 'Integration bootstrap guide',
		summary:
			'START HERE when a third-party integration must work before saving a dependent package or package app: inspect connector/secret state, stop for setup, then run an authenticated smoke test.',
	},
	integration_backed_app: {
		file: 'integration-backed-app-happy-path.md',
		title: 'Integration-backed package app happy path',
		summary:
			'After connector/secret verification and a cheap smoke test, proceed directly to a package app rooted in package.json and package-owned code; avoid unnecessary repo spelunking.',
	},
	oauth: {
		file: 'oauth.md',
		title: 'OAuth guide (standard path)',
		summary:
			'START HERE for third-party OAuth: hosted /connect/oauth, redirect URI, required query params, PKCE vs confidential, vs MCP OAuth.',
	},
	generated_ui_oauth: {
		file: 'generated-ui-oauth.md',
		title: 'Package app OAuth guide',
		summary:
			'Edge case: OAuth inside a hosted package app, kodyWidget callbacks, PKCE/exchange helpers—after reading guide `oauth`.',
	},
	connect_secret: {
		file: 'connect-secret.md',
		title: 'Connect secret guide',
		summary:
			'Hosted /connect/secret URL shape, query params, and approval policy for API keys and PATs.',
	},
} as const

const guideIds = Object.keys(kodyOfficialGuideCatalog) as [
	'integration_bootstrap',
	'integration_backed_app',
	'oauth',
	'generated_ui_oauth',
	'connect_secret',
]

function buildRawGithubUrl(file: string): string {
	const { owner, repo, ref, basePath } = KODY_GUIDES_REPO
	return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${basePath}/${file}`
}

export function buildKodyOfficialGuideUrlForTest(
	guide: KodyOfficialGuideId,
): string {
	const entry = kodyOfficialGuideCatalog[guide]
	return buildRawGithubUrl(entry.file)
}

async function fetchGuideMarkdown(guide: KodyOfficialGuideId): Promise<string> {
	const file = kodyOfficialGuideCatalog[guide].file
	const url = buildRawGithubUrl(file)
	let response: Response
	try {
		response = await fetch(url, {
			headers: { Accept: 'text/markdown, text/plain;q=0.9' },
			redirect: 'follow',
		})
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause)
		throw new Error(`Kody guide fetch failed: ${message}`)
	}

	if (!response.ok) {
		throw new Error(
			`Kody guide fetch failed: HTTP ${response.status} for ${url}`,
		)
	}

	const body = await response.text()
	if (body.length > MAX_GUIDE_BODY_CHARS) {
		throw new Error(
			`Kody guide fetch failed: response exceeds ${MAX_GUIDE_BODY_CHARS} characters`,
		)
	}
	return body
}

function buildCapabilityDescription(): string {
	const lines = guideIds.map((id) => {
		const g = kodyOfficialGuideCatalog[id]
		return `- \`${id}\`: ${g.summary}`
	})
	return [
		'Load an official Kody guide from the kody GitHub repository (markdown). **For third-party integrations that will power a package, package app, or workflow, use `guide: "integration_bootstrap"` first.** After the smoke test passes and you are ready to build a package app, use `guide: "integration_backed_app"` for the default package-app pattern. For OAuth mechanics, then use `guide: "oauth"` (standard `/connect/oauth` path). Use `generated_ui_oauth` only for custom package-app OAuth. For API keys/PATs, use `connect_secret`. If you are unsure, **call this capability** with the right `guide` instead of guessing.',
		'',
		'Available guides (order matters—start with `integration_bootstrap` for integration-dependent work):',
		...lines,
		'',
		'Requires network access to raw.githubusercontent.com; failures surface as errors (no offline copy).',
	].join('\n')
}

const guideFieldSchema = z
	.enum(guideIds)
	.describe(
		[
			'Which guide to load.',
			'`integration_bootstrap`: required sequence before building packages/package apps that depend on a third-party integration.',
			'`integration_backed_app`: default package-app construction pattern after the integration smoke test passes.',
			'`oauth`: standard third-party OAuth via /connect/oauth (read this first for OAuth).',
			'`generated_ui_oauth`: edge case—OAuth in a hosted package app.',
			'`connect_secret`: /connect/secret for API keys and PATs.',
		].join(' '),
	)

const inputSchema = z.object({
	guide: guideFieldSchema,
})

const outputSchema = z.object({
	title: z.string().describe('Guide title.'),
	body: z
		.string()
		.describe(
			'Markdown body from the repository guide file (official, versioned on main).',
		),
})

const allKeywords = [
	...new Set([
		'oauth',
		'integration bootstrap',
		'bootstrap',
		'integration backed app',
		'third-party integration',
		'connector_list',
		'secret_list',
		'smoke test',
		'package app',
		'package app entry',
		'worker fetch app',
		'pkce',
		'generated ui',
		'hosted callback',
		'redirect uri',
		'provider registration',
		'package_save',
		'open_generated_ui',
		'@kody/ui-utils',
		'connect oauth',
		'secret',
		'api key',
		'personal access token',
		'connect secret',
		'credentials',
		'official guide',
		'documentation',
		'kody',
		'unsure',
		'how to',
	]),
]

export const kodyOfficialGuideCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'kody_official_guide',
		description: buildCapabilityDescription(),
		keywords: [...allKeywords],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, _ctx: CapabilityContext) {
			const entry = kodyOfficialGuideCatalog[args.guide]
			const body = await fetchGuideMarkdown(args.guide)
			return {
				title: entry.title,
				body,
			}
		},
	},
)
