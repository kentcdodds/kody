import { getAppBaseUrl } from '#app/app-base-url.ts'
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
		'First explain what Kody can do for me in plain language.',
		'Then help me set up the basics for my account — for example secrets, integrations, or packages I might need.',
		'Prefer searching first, then executing.',
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

export async function loadOnboardingData(input: {
	env: OnboardingEnv
	requestUrl: string | URL
	stableUserId: string
	emailVerified: boolean
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
		mcpServerUrl,
		setupPrompt,
		hasMcpClient,
		emailVerified: input.emailVerified,
		needsOnboarding,
	}
}
