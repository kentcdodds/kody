import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	FORK_OUTDATED_COPY_TOOLTIP,
	renderCopyPromptPill,
} from '#universal/fork-outdated-copy-button.tsx'

test('fork outdated copy pill reveals its tooltip on hover devices', async () => {
	const html = await renderToString(
		renderCopyPromptPill({
			label: 'Fork outdated',
			prompt: 'Compare the listing and absorb updates.',
			testId: 'community-detail-listing-ahead-badge',
			tooltip: FORK_OUTDATED_COPY_TOOLTIP,
			tone: 'outdated',
		}),
	)

	expect(html).toMatch(
		/@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*&:hover \[role="tooltip"\] \{\s*opacity: 1;\s*visibility: visible;/,
	)
	expect(html).toContain(FORK_OUTDATED_COPY_TOOLTIP)
})
