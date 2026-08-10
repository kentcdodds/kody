import {
	buildDiscoveryPrompt,
	buildFirstWinPrompt,
	buildMcpServerUrl,
	buildOnboardingSetupPrompt,
} from '#worker/onboarding-prompts.ts'
import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'
import {
	type OnboardingBuiltInProvider,
	type OnboardingChecklistLoaderData,
	type OnboardingLoaderData,
	type OnboardingWelcomeEmail,
} from '#universal/loader-data.ts'

export {
	buildDiscoveryPrompt,
	buildFirstWinPrompt,
	buildMcpServerUrl,
	buildOnboardingSetupPrompt,
}

type OnboardingEnv = {
	APP_BASE_URL?: string | null
	OAUTH_PROVIDER?: {
		listUserGrants(
			userId: string,
			options?: { cursor?: string },
		): Promise<{ items: Array<unknown>; cursor?: string }>
	}
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
		firstWinPrompt: buildFirstWinPrompt({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
		hasSentWelcomeEmail: false,
		welcomeEmail: null,
		hasMcpClient: false,
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
		builtInProviders: [],
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
	/** Top enabled built-in integrations, loaded by the handler. */
	builtInProviders?: Array<OnboardingBuiltInProvider>
	/** Derived progress checklist, computed by the handler. */
	checklist?: OnboardingChecklistLoaderData | null
	/** Stored welcome email metadata, loaded by the handler. */
	welcomeEmail?: OnboardingWelcomeEmail | null
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
		firstWinPrompt: input.emailVerified
			? buildFirstWinPrompt({
					env: input.env,
					requestUrl: input.requestUrl,
				})
			: '',
		hasMcpClient,
		emailVerified: input.emailVerified,
		needsOnboarding,
		featuredListings: input.emailVerified ? (input.featuredListings ?? []) : [],
		builtInProviders: input.emailVerified ? (input.builtInProviders ?? []) : [],
		// Computed by the handler alongside the checklist probes.
		hasSentWelcomeEmail: false,
		welcomeEmail: input.welcomeEmail ?? null,
		checklist: input.checklist ?? null,
	}
}
