import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { canonicalOnboardingAgentChooser } from '#universal/onboarding-mcp-clients.ts'
import { onboardingSecondAgentHref } from '#universal/onboarding-process.ts'
import { OnboardingMcpClientTabs } from './onboarding-mcp-client-tabs.tsx'
import { defaultKodyMcpUrl } from './onboarding-mcp-clients.ts'
import { onboardingAgentPickerPrefetchHrefs } from './onboarding-picker-prefetch.ts'

function chipHrefsFromHtml(html: string, testIdPrefix: string) {
	return [
		...html.matchAll(
			new RegExp(
				`href="(/onboarding/[^"]+)"[^>]*data-testid="${testIdPrefix}[^"]*"`,
				'g',
			),
		),
	].map((match) => match[1] ?? '')
}

test('step 1 picker prefetch matches every rendered chip', async () => {
	const chooser = canonicalOnboardingAgentChooser()
	const agentHrefs = onboardingAgentPickerPrefetchHrefs(null, chooser)
	const agentHtml = await renderToString(
		jsx(OnboardingMcpClientTabs, { mcpServerUrl: defaultKodyMcpUrl }),
	)
	expect(chipHrefsFromHtml(agentHtml, 'onboarding-agent-')).toEqual(agentHrefs)
	expect(agentHrefs).toContain('/onboarding/step-1/cursor')
	expect(agentHrefs).toContain('/onboarding/step-1/not-listed')
	expect(agentHrefs).toContain('/onboarding/step-1/chatgpt')
	expect(onboardingAgentPickerPrefetchHrefs('cursor', chooser)).toEqual([])
})

test('step 3 picker prefetch uses second-agent hrefs and keeps search', async () => {
	const search = '?redirectTo=%2Faccount'
	const chooser = canonicalOnboardingAgentChooser()
	const hrefs = onboardingAgentPickerPrefetchHrefs(
		null,
		chooser,
		search,
		onboardingSecondAgentHref,
	)
	const html = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			search,
			agentHref: onboardingSecondAgentHref,
			greyedAgents: ['chatgpt', 'codex'],
			greyedReason: 'Same ecosystem as Codex',
		}),
	)
	expect(hrefs).toContain(`/onboarding/step-3/cursor${search}`)
	expect(hrefs).toContain(`/onboarding/step-3/claude-code${search}`)
	expect(html).toContain(
		'href="/onboarding/step-3/cursor?redirectTo=%2Faccount"',
	)
	expect(html).toContain('data-greyed="true"')
	expect(html).toContain('data-testid="onboarding-agent-chatgpt"')
	expect(html).not.toContain(
		'href="/onboarding/step-3/chatgpt?redirectTo=%2Faccount"',
	)
})
