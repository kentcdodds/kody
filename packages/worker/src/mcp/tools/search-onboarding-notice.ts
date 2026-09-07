import {
	formatOnboardingSearchNotice,
	remainingOnboardingWizardLabels,
} from '#universal/onboarding-process.ts'
import { hasSecondConnectedMcpClient } from '#universal/connected-mcp-agents.ts'
import {
	loadOnboardingAccessWin,
	readOnboardingChecklistDismissed,
} from '#mcp/onboarding-checklist.ts'
import { loadInboundMcpConnectionState } from '#worker/connected-mcp-agents.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { type OAuthGrantListHelpers } from '#worker/oauth-grants.ts'

/**
 * One-line onboarding reminder appended to `search` notices, at most once per
 * conversation (the runner tracks shown conversations in agent state) and
 * only while wizard steps remain and the homepage checklist is undismissed.
 * Leftover labels match the three wizard steps, not a quest of extras.
 * Search does not write the dismissal column; that stays on `/onboarding`.
 */

export async function buildOnboardingSearchNotice(input: {
	env: Env
	userId: string
	/** Deployment origin for the details link, e.g. https://kody.codes */
	baseUrl: string
}): Promise<string | null> {
	try {
		const dismissed = await readOnboardingChecklistDismissed({
			env: input.env,
			userId: input.userId,
		})
		if (dismissed) return null

		const helpers = await resolveOAuthHelpers<OAuthGrantListHelpers>(input.env)
		if (!helpers) return null
		const [inbound, hasAccessWin] = await Promise.all([
			loadInboundMcpConnectionState(helpers, input.userId),
			loadOnboardingAccessWin(input.env, input.userId),
		])
		const remaining = remainingOnboardingWizardLabels({
			hasMcpClient: inbound.uniqueClientCount > 0,
			hasAccessWin,
			hasSecondMcpClient: hasSecondConnectedMcpClient(
				inbound.uniqueClientCount,
			),
		})
		return formatOnboardingSearchNotice(remaining, input.baseUrl)
	} catch {
		// The reminder is a courtesy; never let it break search.
		return null
	}
}
