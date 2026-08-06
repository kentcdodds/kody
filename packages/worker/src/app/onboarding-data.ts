import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { type OnboardingFeaturedListing } from '#app/community-public-types.ts'
import { type OnboardingLoaderData } from '#app/loader-data.ts'

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
 * only assumes the agent can fetch a URL or search the web, and points at the
 * GitHub usage docs, which resolve without any Kody account or MCP session.
 * The parenthetical identifies this deployment (heykody.dev in production).
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
		'Read https://github.com/kentcdodds/kody/blob/main/docs/use/what-can-kody-do.md and follow its links for anything you need more detail on.',
		"Interview me conversationally about the tools I use, recurring chores I do by hand, and automations I've wished for.",
		'Ask at most 2 short questions per message, then wait for my answer.',
		'Keep each message under roughly 120 words until your final recommendations.',
		'Finish with 3–5 specific things Kody could do for me, ranked by payoff versus setup effort, each with a concrete first step.',
		"Don't set anything up yet — this works before I have an account.",
		`After the ranked list, finish with a short "Next steps if you want to connect me to Kody" section. Point me to ${origin}/onboarding and explain that the only setup is adding Kody as an MCP server there — there is no CLI to install.`,
	].join(' ')
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
		hasMcpClient: false,
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
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
		hasMcpClient,
		emailVerified: input.emailVerified,
		needsOnboarding,
		featuredListings: input.emailVerified ? (input.featuredListings ?? []) : [],
	}
}
