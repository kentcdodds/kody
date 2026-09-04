import {
	formatOnboardingSearchNotice,
	remainingOnboardingSessionMilestoneLabels,
} from '#universal/onboarding-process.ts'
import { readOnboardingChecklistDismissed } from '#mcp/onboarding-checklist.ts'
import { loadOnboardingMilestones } from '#mcp/onboarding-milestones.ts'

/**
 * One-line onboarding reminder appended to `search` notices, at most once per
 * conversation (the runner tracks shown conversations in agent state) and
 * only while session milestones are incomplete and the homepage checklist is
 * undismissed. The leftover steps are the same tasks and labels as the
 * Step 2 milestone list. Search does not write the dismissal column; that
 * stays on `/onboarding` so search can stay read-only.
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

		const remaining = remainingOnboardingSessionMilestoneLabels(
			await loadOnboardingMilestones(input.env, input.userId),
		)
		return formatOnboardingSearchNotice(remaining, input.baseUrl)
	} catch {
		// The reminder is a courtesy; never let it break search.
		return null
	}
}
