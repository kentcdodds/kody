import {
	type OnboardingAgentChooserPick,
	type McpClientKind,
	canonicalOnboardingAgentChooser,
	onboardingNotListedAgentIds,
	onboardingPickerAgentIds,
} from '#universal/onboarding-mcp-clients.ts'
import { onboardingAgentHref } from '#universal/onboarding-process.ts'

type OnboardingAgentHref = (
	agent: McpClientKind | null,
	search?: string,
) => string

/**
 * Destinations for every Step 1 (or Step 3) chip currently on screen. The
 * main picker includes Not listed. Extra named hosts only appear after that
 * choice, so they are not warmed on the first grid.
 */
export function onboardingAgentPickerPrefetchHrefs(
	selectedAgent: McpClientKind | null,
	chooser: OnboardingAgentChooserPick = canonicalOnboardingAgentChooser(),
	search = '',
	agentHref: OnboardingAgentHref = onboardingAgentHref,
): Array<string> {
	if (!selectedAgent) {
		const ids: Array<McpClientKind> = [
			...onboardingPickerAgentIds(chooser),
			'other',
		]
		return ids.map((id) => agentHref(id, search))
	}
	if (selectedAgent === 'other') {
		return onboardingNotListedAgentIds(chooser).map((entry) =>
			agentHref(entry.id, search),
		)
	}
	return []
}
