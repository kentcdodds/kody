import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	guideMetadataList,
	importGuideCatalog,
} from '#worker/guide-catalog-modules.ts'

/**
 * Guide markdown is bundled from `docs/guides/` at build time (see
 * `#worker/guides/catalog.ts` for the web-facing catalog), so this
 * capability, the `/guides` web pages, and the raw `text/markdown`
 * responses always serve the same deployed content with no request-time
 * GitHub dependency.
 *
 * Only `guideMetadataList` (frontmatter, no bodies) is statically imported
 * here — registering `coding_guide_get` must not add every guide body's
 * parse/link cost to every platform/runtime Worker isolate's main-module
 * cold start. The full catalog is loaded lazily by `importGuideCatalog()`
 * inside the handler; see `#worker/guide-catalog-modules.ts`.
 */

const advertisedGuides = guideMetadataList.filter(
	(guide) => !guide.unadvertised,
)
const knownGuideIds = new Set(guideMetadataList.map((guide) => guide.id))

function buildCapabilityDescription(): string {
	return [
		'Load an official Kody guide (markdown, bundled from the kody repository).',
		'Prefer this capability plus `search` results over local repo spelunking when Kody auth or integration behavior is already documented.',
		'Use `guide: "package_authoring"` for package creation or material package updates, and `guide: "integration_bootstrap"` before building integration-dependent packages, package apps, or workflows.',
		'Use `guide: "how_kody_works"` to explain the factory loop: ask once, save an export, invoke from any agent, then a quiet daily email.',
		'Use `guide: "package_lifecycle"` to choose reuse vs temporary execute vs community fork vs deferred workflows vs a new durable package, and before enabling package-owned schedules.',
		'Use `guide: "locked_gmail_drafts"` when an OAuth token is coarser than the intended published surface — Gmail has send-only and no drafts-only scope — and the owner should lock a drafts-only package so it cannot grow into send.',
		'Use `guide: "locked_mcp_server"` when a connected MCP server should be callable only from a named package — not from ad hoc execute or other packages.',
		'Integration bootstrap covers checking saved `integration` / `secret` entities, running a cheap authenticated smoke test, then preferring a trusted community fork before building.',
		'Use `guide: "platform_friction"` for meaningful Kody friction, bugs, poor experiences, or suggestions; it distinguishes inline fixes, approved memory changes, and consent-gated attributed feedback.',
		'Provider guides (`provider_*`) give verified per-provider connect walkthroughs (console steps, endpoints, scopes, gotchas, smoke test); load one before improvising OAuth-app or API-key setup for that provider.',
		'',
		'The `guide` input describes each available guide and when to use it. If you are unsure, call this capability instead of guessing.',
	].join('\n')
}

const guideFieldSchema = z
	.string()
	.refine((id) => knownGuideIds.has(id), {
		message: 'Unknown Kody guide.',
	})
	.describe(
		[
			'Which guide to load.',
			...advertisedGuides.map((guide) => `\`${guide.id}\`: ${guide.summary}`),
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
			'Markdown body bundled from the repository guide file (official, versioned with the deployment).',
		),
})

const providerKeywords = guideMetadataList
	.filter((guide) => guide.provider !== null)
	.flatMap((guide) => [
		guide.provider!.toLowerCase(),
		`connect ${guide.provider!.toLowerCase()}`,
	])

const allKeywords = [
	...new Set([
		'oauth',
		'integration bootstrap',
		'locked gmail drafts',
		'locked mcp server',
		'mcp server package lock',
		'mcp usage mode',
		'gmail drafts only',
		'gmail compose',
		'drafts without send',
		'publish lock',
		'locked package',
		'gmail.compose',
		'gmail.send',
		'package authoring',
		'package lifecycle',
		'durable package',
		'repo-backed package',
		'package escalation',
		'temporary execute',
		'one-off exploration',
		'deferred workflow',
		'workflows.create',
		'package export testing',
		'job wrapper testing',
		'no-input entrypoint',
		'representative input',
		'dry run',
		'dryRun',
		'package-owned schedule',
		'disabled schedule',
		'package creation',
		'package update',
		'readme intent',
		'intent section',
		'jsdoc',
		'export jsdoc',
		'export purpose',
		'@param',
		'@returns',
		'@example',
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
		'hosted callback',
		'redirect uri',
		'provider registration',
		'package_save',
		'connect oauth',
		'secret',
		'api key',
		'personal access token',
		'connect secret',
		'package subscription',
		'package subscriptions',
		'platform friction',
		'platform feedback',
		'feedback submission',
		'bug report',
		'poor experience',
		'suggestion',
		'self improvement',
		'self-improvement',
		'friction',
		'workaround',
		'agent improvement',
		'package_subscriptions_list',
		'package.json#kody.subscriptions',
		'email.message.received',
		'email message received',
		'run.error.recorded',
		'run error recorded',
		'activity error notification',
		'platform.feedback.submitted',
		'platform feedback submitted',
		'feedback notification event',
		'community.listing.published',
		'community listing published',
		'status.incident.opened',
		'status incident opened',
		'status.incident.resolved',
		'status incident resolved',
		'status page incident',
		'fleet.package_error_rate.elevated',
		'fleet package error rate',
		'package error rate alert',
		'fleet.entitlement.crossed',
		'fleet entitlement crossed',
		'entitlement crossing',
		'user.created',
		'user created',
		'user.deleted',
		'user deleted',
		'user.email_verification.failed',
		'email verification failed',
		'user.email_outbound.paused',
		'outbound email paused',
		'auth.denial.burst',
		'auth denial burst',
		'email.delivery.burst',
		'email delivery burst',
		'account created',
		'account deleted',
		'untrusted feedback',
		'admin feedback deep link',
		'feedback dispatch queue',
		'metadata-first payload',
		'event handler',
		'heartbeat',
		'reconnect',
		'resume',
		'credentials',
		'official guide',
		'documentation',
		'openapi',
		'openapi binding',
		'provider guide',
		'setup guide',
		'developer console',
		'oauth app',
		'kody',
		'unsure',
		'how to',
		'how kody works',
		'software factory',
		'factory loop',
		'kody-bot',
		'daily email',
		'home mcp',
		'home mcp starter',
		'cloudflare tunnel',
		'cloudflare access',
		'cimd',
		'client id metadata',
		'local mcp',
		'nas',
		'home automation',
		'docker home',
		...providerKeywords,
	]),
]

export const kodyOfficialGuideCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'coding_guide_get',
		description: buildCapabilityDescription(),
		keywords: [...allKeywords],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, _ctx: CapabilityContext) {
			const { guides } = await importGuideCatalog()
			const guide = guides.find((candidate) => candidate.id === args.guide)
			if (!guide) {
				throw new Error(`Unknown Kody guide "${args.guide}".`)
			}
			return {
				title: guide.title,
				body: guide.body,
			}
		},
	},
)
