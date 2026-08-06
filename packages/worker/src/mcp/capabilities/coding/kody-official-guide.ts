import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getGuideById, guides } from '#worker/guides/catalog.ts'

/**
 * Guide markdown is bundled from `docs/guides/` at build time (see
 * `#worker/guides/catalog.ts`), so this capability, the `/guides` web pages,
 * and the raw `text/markdown` responses always serve the same deployed
 * content with no request-time GitHub dependency.
 */

const guideIds = guides.map((guide) => guide.id)

function buildCapabilityDescription(): string {
	return [
		'Load an official Kody guide (markdown, bundled from the kody repository).',
		'Prefer this capability plus `search` results over local repo spelunking when Kody auth or integration behavior is already documented.',
		'Use `guide: "package_authoring"` for package creation or material package updates, and `guide: "integration_bootstrap"` before building integration-dependent packages, package apps, or workflows.',
		'Use `guide: "package_lifecycle"` to choose reuse vs temporary execute vs community fork vs direct job scheduling vs a new durable package, and before enabling package-owned schedules.',
		'Integration bootstrap covers checking saved `integration` / `secret` entities, running a cheap authenticated smoke test, then preferring a trusted community fork before building.',
		'Use `guide: "platform_friction"` for meaningful Kody friction, bugs, poor experiences, or suggestions; it distinguishes inline fixes, approved memory changes, and consent-gated attributed feedback.',
		'Provider guides (`provider_*`) give verified per-provider connect walkthroughs (console steps, endpoints, scopes, gotchas, smoke test); load one before improvising OAuth-app or API-key setup for that provider.',
		'',
		'The `guide` input describes each available guide and when to use it. If you are unsure, call this capability instead of guessing.',
	].join('\n')
}

const guideFieldSchema = z
	.enum(guideIds as [string, ...Array<string>])
	.describe(
		[
			'Which guide to load.',
			...guides.map((guide) => `\`${guide.id}\`: ${guide.summary}`),
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

const providerKeywords = guides
	.filter((guide) => guide.provider !== null)
	.flatMap((guide) => [
		guide.provider!.toLowerCase(),
		`connect ${guide.provider!.toLowerCase()}`,
	])

const allKeywords = [
	...new Set([
		'oauth',
		'integration bootstrap',
		'package authoring',
		'package lifecycle',
		'durable package',
		'repo-backed package',
		'package escalation',
		'temporary execute',
		'one-off exploration',
		'direct job scheduling',
		'job_schedule',
		'ad hoc job',
		'self-contained schedule',
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
		'package service',
		'service package',
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
		'untrusted feedback',
		'admin feedback deep link',
		'feedback dispatch queue',
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
		'openapi',
		'openapi binding',
		'provider guide',
		'setup guide',
		'developer console',
		'oauth app',
		'kody',
		'unsure',
		'how to',
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
			const guide = getGuideById(args.guide)
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
