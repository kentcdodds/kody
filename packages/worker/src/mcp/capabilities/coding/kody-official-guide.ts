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
	package_authoring: {
		file: 'package-authoring.md',
		title: 'Package authoring guide',
		summary:
			'START HERE when creating or materially changing a Kody package: package shape, README.md Intent section, and scope-update guidance without adding new primitives.',
	},
	integration_bootstrap: {
		file: 'integration-bootstrap.md',
		title: 'Integration bootstrap guide',
		summary:
			'START HERE when a third-party integration must work before saving a dependent package or package app: inspect integration/secret state, stop for setup, then run an authenticated smoke test.',
	},
	secret_backed_integration: {
		file: 'secret-backed-integration.md',
		title: 'Secret-backed integration recipe',
		summary:
			'Default non-OAuth recipe for secret-backed integrations: research auth, collect secrets through /account/secrets/new, run a smoke test, then build the downstream package or workflow.',
	},
	integration_backed_app: {
		file: 'integration-backed-app-happy-path.md',
		title: 'Integration-backed package app happy path',
		summary:
			'After integration/secret verification and a cheap smoke test, proceed directly to a package app rooted in package.json and package-owned code; avoid unnecessary repo spelunking.',
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
		file: 'account-secret-setup.md',
		title: 'Account secret setup guide',
		summary:
			'Hosted /account/secrets/new URL shape, query params, and approval policy for API keys and PATs.',
	},
	package_service_pattern: {
		file: 'package-service-pattern.md',
		title: 'Package service pattern guide',
		summary:
			'Build a package-native long-lived service using kody.services, package app realtime fanout, service-owned storage, background lifecycle helpers, and scheduled wake-ups.',
	},
	package_subscriptions: {
		file: 'package-subscriptions.md',
		title: 'Package subscription guide',
		summary:
			'Use package.json#kody.subscriptions for package-owned event handlers; discover subscribers with package_subscription_list and follow metadata-first email.message.received payload guidance.',
	},
} as const

const guideIds = Object.keys(kodyOfficialGuideCatalog) as Array<
	keyof typeof kodyOfficialGuideCatalog
>

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
	return [
		'Load an official Kody guide from the kody GitHub repository (markdown).',
		'Prefer this capability plus `search` results over local repo spelunking when Kody auth or integration behavior is already documented.',
		'Use `guide: "package_authoring"` for package creation or material package updates, and `guide: "integration_bootstrap"` before building integration-dependent packages, package apps, or workflows.',
		'Integration bootstrap covers checking saved `integration` / `secret` entities and running a cheap authenticated smoke test before building.',
		'',
		'The `guide` input describes each available guide and when to use it. If you are unsure, call this capability instead of guessing.',
	].join('\n')
}

const guideFieldSchema = z
	.enum(guideIds as [KodyOfficialGuideId, ...Array<KodyOfficialGuideId>])
	.describe(
		[
			'Which guide to load.',
			'`package_authoring`: required package-authoring guidance for README.md Intent sections when creating or materially changing packages.',
			'`integration_bootstrap`: required sequence before building packages/package apps that depend on a third-party integration.',
			'`secret_backed_integration`: default non-OAuth recipe after bootstrap when the integration is driven by saved secrets.',
			'`integration_backed_app`: default package-app construction pattern after the integration smoke test passes.',
			'`oauth`: standard third-party OAuth via /connect/oauth (read this first for OAuth).',
			'`generated_ui_oauth`: edge case—OAuth in a hosted package app.',
			'`connect_secret`: /account/secrets/new for API keys, PATs, and other secret collection steps.',
			'`package_service_pattern`: package-native long-lived service architecture built on package services and package app realtime.',
			'`package_subscriptions`: package-owned event subscriptions, package_subscription_list discovery, and email.message.received metadata-first handler payloads.',
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
		'package authoring',
		'package creation',
		'package update',
		'readme intent',
		'intent section',
		'user-defined goal',
		'bootstrap',
		'secret-backed integration',
		'basic auth',
		'account id plus token',
		'integration backed app',
		'third-party integration',
		'integration_list',
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
		'package service',
		'service package',
		'package subscription',
		'package subscriptions',
		'package_subscription_list',
		'package.json#kody.subscriptions',
		'email.message.received',
		'email message received',
		'metadata-first payload',
		'event handler',
		'background service',
		'long-lived service',
		'outbound websocket',
		'heartbeat',
		'reconnect',
		'resume',
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
