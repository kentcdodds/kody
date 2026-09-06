import {
	buildDiscoveryPrompt,
	buildFirstWinPrompt,
	buildMcpServerUrl,
	buildOnboardingSetupPrompt,
	buildPersistFirstPackagePrompt,
} from '#worker/onboarding-prompts.ts'
import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'
import { listDisconnectedOnboardingFeaturedMcpServers } from '#universal/onboarding-mcp-chooser.ts'
import {
	type OnboardingChecklistLoaderData,
	type OnboardingCustomMcpServer,
	type OnboardingFeaturedMcpServer,
	type OnboardingLoaderData,
} from '#universal/loader-data.ts'
export {
	buildDiscoveryPrompt,
	buildFirstWinPrompt,
	buildMcpServerUrl,
	buildOnboardingSetupPrompt,
	buildPersistFirstPackagePrompt,
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
 * Inbound MCP OAuth grant count. Listing failures treat the user as still
 * needing onboarding so the banner stays available.
 */
export async function countMcpOAuthGrants(
	env: OnboardingEnv,
	stableUserId: string,
) {
	const helpers = env.OAUTH_PROVIDER
	if (!helpers) return 0
	try {
		const page = await helpers.listUserGrants(stableUserId)
		return page.items.length
	} catch {
		return 0
	}
}

/**
 * True when the user has at least one inbound MCP OAuth grant (an AI host
 * authorized against this account).
 */
export async function userHasMcpOAuthGrants(
	env: OnboardingEnv,
	stableUserId: string,
) {
	return (await countMcpOAuthGrants(env, stableUserId)) > 0
}

export function loadPublicOnboardingData(input: {
	env: Pick<OnboardingEnv, 'APP_BASE_URL'>
	requestUrl: string | URL
}): OnboardingLoaderData {
	return {
		ok: true,
		loggedIn: false,
		username: null,
		mcpServerUrl: buildMcpServerUrl({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
		setupPrompt: buildOnboardingSetupPrompt(),
		discoveryPrompt: buildDiscoveryPrompt({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
		persistPrompt: buildPersistFirstPackagePrompt({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
		hasAccessWin: false,
		hasSecondMcpClient: false,
		hasMcpClient: false,
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
		featuredMcpServers: listDisconnectedOnboardingFeaturedMcpServers(),
		customMcpServers: [],
		persistedPackageKodyId: null,
		checklist: null,
	}
}

export async function loadOnboardingData(input: {
	env: OnboardingEnv
	requestUrl: string | URL
	stableUserId: string
	username: string
	emailVerified: boolean
	/**
	 * Featured starter packages loaded by the handler (which has the full
	 * worker Env); this module stays narrow so it is trivially testable.
	 */
	featuredListings?: Array<OnboardingFeaturedListing>
	/** Official workspace MCP chooser cards, loaded by the handler. */
	featuredMcpServers?: Array<OnboardingFeaturedMcpServer>
	/** Non-featured MCP servers the viewer added, loaded by the handler. */
	customMcpServers?: Array<OnboardingCustomMcpServer>
	/** Contextual persist prompt, computed by the handler. */
	persistContext?: {
		connectedWorkspaceLabel?: string | null
		installedExampleName?: string | null
	}
	/** Most recently updated saved-package kody id, loaded by the handler. */
	persistedPackageKodyId?: string | null
	/** Derived progress checklist, computed by the handler. */
	checklist?: OnboardingChecklistLoaderData | null
	/** Memory, execute, or saved package — a Step 2 win. */
	hasAccessWin?: boolean
}): Promise<OnboardingLoaderData> {
	const grantCount = await countMcpOAuthGrants(input.env, input.stableUserId)
	const hasMcpClient = grantCount > 0
	const hasSecondMcpClient = grantCount >= 2
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
		username: input.username,
		mcpServerUrl,
		setupPrompt,
		// The discovery prompt needs no MCP connection or verified email, so it
		// stays available even while setup fields are gated.
		discoveryPrompt: buildDiscoveryPrompt({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
		persistPrompt: input.emailVerified
			? buildPersistFirstPackagePrompt({
					env: input.env,
					requestUrl: input.requestUrl,
					connectedWorkspaceLabel:
						input.persistContext?.connectedWorkspaceLabel,
					installedExampleName: input.persistContext?.installedExampleName,
				})
			: '',
		hasAccessWin: input.hasAccessWin ?? false,
		hasSecondMcpClient,
		hasMcpClient,
		emailVerified: input.emailVerified,
		needsOnboarding,
		featuredListings: input.emailVerified ? (input.featuredListings ?? []) : [],
		featuredMcpServers: input.emailVerified
			? (input.featuredMcpServers ??
				listDisconnectedOnboardingFeaturedMcpServers())
			: [],
		customMcpServers: input.emailVerified ? (input.customMcpServers ?? []) : [],
		persistedPackageKodyId: input.emailVerified
			? (input.persistedPackageKodyId ?? null)
			: null,
		checklist: input.checklist ?? null,
	}
}
