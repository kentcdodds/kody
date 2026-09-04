import {
	type OnboardingAgentChooserPick,
	type McpClientKind,
	canonicalOnboardingAgentChooser,
	onboardingNotListedAgentIds,
	onboardingPickerAgentIds,
} from '#universal/onboarding-mcp-clients.ts'
import {
	type OnboardingFeaturedMcpServerId,
	type OnboardingServiceChoice,
	onboardingFeaturedMcpServerById,
	onboardingNotListedPromptServices,
	onboardingNotListedServiceId,
} from '#universal/onboarding-mcp-chooser.ts'
import {
	onboardingAgentHref,
	onboardingServiceHref,
} from '#universal/onboarding-process.ts'

/**
 * Destinations for every Step 1 chip currently on screen. The main picker
 * includes Not listed (`/onboarding/step-1/not-listed`). Extra named hosts
 * only appear after that choice, so they are not warmed on the first grid.
 */
export function onboardingAgentPickerPrefetchHrefs(
	selectedAgent: McpClientKind | null,
	chooser: OnboardingAgentChooserPick = canonicalOnboardingAgentChooser(),
): Array<string> {
	if (!selectedAgent) {
		const ids: Array<McpClientKind> = [
			...onboardingPickerAgentIds(chooser),
			'other',
		]
		return ids.map((id) => onboardingAgentHref(id))
	}
	if (selectedAgent === 'other') {
		return onboardingNotListedAgentIds(chooser).map((entry) =>
			onboardingAgentHref(entry.id),
		)
	}
	return []
}

/**
 * Destinations for every Step 2 chip: featured, Show more remotes, prompt
 * flavors, and Not listed. Explore packages (`/community`) is not a chip
 * and is omitted until a service is selected.
 */
export function onboardingServicePickerPrefetchHrefs(
	featuredIds: ReadonlyArray<OnboardingFeaturedMcpServerId>,
	overflowIds: ReadonlyArray<OnboardingFeaturedMcpServerId>,
): Array<string> {
	const overflowChoices = overflowIds.flatMap((id) => {
		const server = onboardingFeaturedMcpServerById(id)
		if (!server) return []
		return [server.id]
	})
	const ids: Array<OnboardingServiceChoice> = [
		...featuredIds,
		...overflowChoices,
		...onboardingNotListedPromptServices.map((service) => service.id),
		onboardingNotListedServiceId,
	]
	return ids.map((id) => onboardingServiceHref(id))
}
