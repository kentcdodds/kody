import { onboardingChecklistSearchLabels } from '#universal/onboarding-process.ts'
import {
	deriveOnboardingChecklist,
	readOnboardingChecklistDismissed,
} from '#mcp/onboarding-checklist.ts'

/**
 * One-line onboarding reminder appended to `search` notices, at most once per
 * conversation (the runner tracks shown conversations in agent state) and
 * only while the derived checklist is incomplete and undismissed. Search does
 * not write the dismissal column; that stays on `/onboarding` so search can
 * stay read-only.
 */

const itemLabels = onboardingChecklistSearchLabels

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

		// An MCP search call implies a verified account and a connected agent.
		const checklist = await deriveOnboardingChecklist({
			env: input.env,
			userId: input.userId,
			emailVerified: true,
			hasMcpClient: true,
		})
		if (checklist.complete) {
			return null
		}

		const remaining = checklist.items
			.filter((item) => !item.done)
			.map((item) => itemLabels[item.id])
		return `Onboarding: ${remaining.length} step${remaining.length === 1 ? '' : 's'} left — ${remaining.join(', ')}. Details and dismissal: ${input.baseUrl}/onboarding`
	} catch {
		// The reminder is a courtesy; never let it break search.
		return null
	}
}
