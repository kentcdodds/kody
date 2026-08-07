import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { type OnboardingFeaturedListing } from '#app/community-public-types.ts'
import {
	type OnboardingChecklistLoaderData,
	type OnboardingLoaderData,
} from '#app/loader-data.ts'

const mcpServerPath = '/mcp'

type OnboardingEnv = {
	APP_BASE_URL?: string | null
	OAUTH_PROVIDER?: {
		listUserGrants(
			userId: string,
			options?: { cursor?: string },
		): Promise<{ items: Array<unknown>; cursor?: string }>
	}
}

export function buildMcpServerUrl(input: {
	env: Pick<OnboardingEnv, 'APP_BASE_URL'>
	requestUrl: string | URL
}) {
	return `${getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})}${mcpServerPath}`
}

export function buildOnboardingSetupPrompt() {
	return [
		'Help me get started with Kody.',
		'First, briefly explain what Kody can do for me in plain language.',
		'Then help me connect one integration I care about: check coding_guide_get for a matching provider guide (for example provider_github or provider_google) and follow it; otherwise use search and the official guides to find the right setup steps, walk me through the connect or secrets flow, and verify the connection with a small ad hoc execute smoke test.',
		'Do not create any packages until the integration works — start with ad hoc execute calls.',
		'Once the integration works, check community_search for a trusted community package that is close to what I want, fork or adapt it (community_fork, or point me at one-click install on /onboarding or the listing detail), and only create a new package if nothing suitable exists.',
	].join(' ')
}

/**
 * Discovery prompt for people who have not connected (or signed up) yet. It
 * only assumes the agent can fetch a URL: the interview steering lives in
 * the `what-is-kody` guide itself (as embedded notes for agents), so the
 * prompt stays short enough to read before pasting. The parenthetical
 * identifies this deployment (heykody.dev in production).
 */
export function buildDiscoveryPrompt(input: {
	env: Pick<OnboardingEnv, 'APP_BASE_URL'>
	requestUrl: string | URL
}) {
	const origin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	return [
		`I'm deciding whether Kody (${origin}) would be useful for me.`,
		`Read ${origin}/guides/what-is-kody and then interview me to find out what Kody could do for me.`,
		"Don't set anything up yet — this works before I have an account.",
	].join(' ')
}

/**
 * First-win prompt: a visible result inside a minute with zero third-party
 * setup. The email invites a reply on purpose — replying and then asking the
 * agent to read the reply teaches the storage-first email model (Kody stores
 * mail; the agent reads it when asked; nothing answers by itself).
 */
export function buildIntroEmailPrompt() {
	return 'Hey Kody, send me a welcome email introducing yourself, and invite me to reply to it.'
}

/**
 * Follow-up after the user replies to the welcome email. Kept separate from
 * the send prompt so the UI can show "reply, then ask your agent to look it
 * up" as an explicit second paste.
 */
export function buildIntroEmailLookupPrompt() {
	return 'Hey Kody, look up my reply to your welcome email and tell me what I said.'
}

/** Second first-win prompt: start durable memory with a tiny interview. */
export function buildMemoryPrompt() {
	return 'Hey Kody, ask me a couple of questions about who I am and what I work with, then remember what matters.'
}

/**
 * True when the user has at least one inbound MCP OAuth grant (an AI host
 * authorized against this account). Listing failures treat the user as still
 * needing onboarding so the banner stays available.
 */
export async function userHasMcpOAuthGrants(
	env: OnboardingEnv,
	stableUserId: string,
) {
	const helpers = env.OAUTH_PROVIDER
	if (!helpers) return false
	try {
		const page = await helpers.listUserGrants(stableUserId)
		return page.items.length > 0
	} catch {
		return false
	}
}

export function loadPublicOnboardingData(input: {
	env: Pick<OnboardingEnv, 'APP_BASE_URL'>
	requestUrl: string | URL
}): OnboardingLoaderData {
	return {
		ok: true,
		loggedIn: false,
		mcpServerUrl: buildMcpServerUrl({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
		setupPrompt: buildOnboardingSetupPrompt(),
		discoveryPrompt: buildDiscoveryPrompt({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
		introEmailPrompt: buildIntroEmailPrompt(),
		introEmailLookupPrompt: buildIntroEmailLookupPrompt(),
		memoryPrompt: buildMemoryPrompt(),
		hasMcpClient: false,
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
		checklist: null,
	}
}

export async function loadOnboardingData(input: {
	env: OnboardingEnv
	requestUrl: string | URL
	stableUserId: string
	emailVerified: boolean
	/**
	 * Featured starter packages loaded by the handler (which has the full
	 * worker Env); this module stays narrow so it is trivially testable.
	 */
	featuredListings?: Array<OnboardingFeaturedListing>
	/** Derived progress checklist, computed by the handler. */
	checklist?: OnboardingChecklistLoaderData | null
}): Promise<OnboardingLoaderData> {
	const hasMcpClient = await userHasMcpOAuthGrants(
		input.env,
		input.stableUserId,
	)
	// Incomplete setup means either the account email is still unverified or no
	// MCP host has authorized yet. An unverified account with a leftover grant
	// still needs onboarding until verification is finished.
	const needsOnboarding = !input.emailVerified || !hasMcpClient
	// Keep MCP URL/setup out of unverified responses so SSR and JSON clients
	// cannot push users into the authorize → 403 loop before verification.
	const mcpServerUrl = input.emailVerified
		? buildMcpServerUrl({
				env: input.env,
				requestUrl: input.requestUrl,
			})
		: ''
	const setupPrompt = input.emailVerified ? buildOnboardingSetupPrompt() : ''
	return {
		ok: true,
		loggedIn: true,
		mcpServerUrl,
		setupPrompt,
		// The discovery prompt needs no MCP connection or verified email, so it
		// stays available even while setup fields are gated.
		discoveryPrompt: buildDiscoveryPrompt({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
		introEmailPrompt: input.emailVerified ? buildIntroEmailPrompt() : '',
		introEmailLookupPrompt: input.emailVerified
			? buildIntroEmailLookupPrompt()
			: '',
		memoryPrompt: input.emailVerified ? buildMemoryPrompt() : '',
		hasMcpClient,
		emailVerified: input.emailVerified,
		needsOnboarding,
		featuredListings: input.emailVerified ? (input.featuredListings ?? []) : [],
		checklist: input.checklist ?? null,
	}
}
