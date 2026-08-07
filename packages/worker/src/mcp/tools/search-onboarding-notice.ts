import {
	deriveOnboardingChecklist,
	dismissOnboardingChecklist,
	readOnboardingChecklistDismissed,
	type OnboardingChecklistItemId,
} from '#mcp/onboarding-checklist.ts'

/**
 * One-line onboarding reminder appended to `search` notices, at most once per
 * conversation (the runner tracks shown conversations in agent state) and
 * only while the derived checklist is incomplete and undismissed. When the
 * checklist completes, the dismissal value is written automatically so
 * established accounts stop paying the derivation on new conversations.
 */

const itemLabels: Record<OnboardingChecklistItemId, string> = {
	'verify-email': 'verify your email',
	'connect-agent': 'connect your agent',
	'first-hello': 'exchange a first email with Kody',
	'save-memory': 'save a memory',
	'connect-integration': 'connect an integration',
	'install-starter': 'install a starter package',
}

export async function buildOnboardingSearchNotice(input: {
	env: Env
	userId: string
	/** Deployment origin for the details link, e.g. https://heykody.app */
	baseUrl: string
	waitUntil?: (promise: Promise<unknown>) => void
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
			const retire = dismissOnboardingChecklist({
				env: input.env,
				userId: input.userId,
			}).catch(() => {})
			if (input.waitUntil) input.waitUntil(retire)
			else await retire
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
