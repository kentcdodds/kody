import {
	formatOnboardingSearchNotice,
	remainingOnboardingWizardLabels,
} from '#universal/onboarding-process.ts'
import {
	loadOnboardingAccessWin,
	readOnboardingChecklistDismissed,
} from '#mcp/onboarding-checklist.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'

type GrantCountEnv = Env & {
	OAUTH_PROVIDER?: {
		listUserGrants(
			userId: string,
			options?: { cursor?: string },
		): Promise<{ items: Array<unknown>; cursor?: string }>
	}
}

/**
 * One-line onboarding reminder appended to `search` notices, at most once per
 * conversation (the runner tracks shown conversations in agent state) and
 * only while wizard steps remain and the homepage checklist is undismissed.
 * Leftover labels match the three wizard steps, not a quest of extras.
 * Search does not write the dismissal column; that stays on `/onboarding`.
 */

async function countInboundMcpGrants(
	env: GrantCountEnv,
	userId: string,
): Promise<number | null> {
	try {
		const helpers = await resolveOAuthHelpers(env)
		if (!helpers) return null
		const page = await helpers.listUserGrants(userId)
		return page.items.length
	} catch {
		return null
	}
}

export async function buildOnboardingSearchNotice(input: {
	env: GrantCountEnv
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

		const [grantCount, hasAccessWin] = await Promise.all([
			countInboundMcpGrants(input.env, input.userId),
			loadOnboardingAccessWin(input.env, input.userId),
		])
		if (grantCount === null) return null
		const remaining = remainingOnboardingWizardLabels({
			hasMcpClient: grantCount > 0,
			hasAccessWin,
			hasSecondMcpClient: grantCount >= 2,
		})
		return formatOnboardingSearchNotice(remaining, input.baseUrl)
	} catch {
		// The reminder is a courtesy; never let it break search.
		return null
	}
}
