import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { canonicalOnboardingAgentChooser } from '#universal/onboarding-mcp-clients.ts'
import { OnboardingMcpClientTabs } from './onboarding-mcp-client-tabs.tsx'
import { defaultKodyMcpUrl } from './onboarding-mcp-clients.ts'
import {
	onboardingAgentPickerPrefetchHrefs,
	onboardingServicePickerPrefetchHrefs,
} from './onboarding-picker-prefetch.ts'
import { OnboardingServicePicker } from './onboarding-service-picker.tsx'

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

test('step 1 and step 2 pickers prefetch every rendered chip and never community', async () => {
	const chooser = canonicalOnboardingAgentChooser()
	const agentHrefs = onboardingAgentPickerPrefetchHrefs(null, chooser)
	const agentHtml = await renderToString(
		jsx(OnboardingMcpClientTabs, { mcpServerUrl: defaultKodyMcpUrl }),
	)
	expect(chipHrefsFromHtml(agentHtml, 'onboarding-agent-')).toEqual(agentHrefs)
	expect(agentHrefs).toContain('/onboarding/step-1/cursor')
	expect(agentHrefs).toContain('/onboarding/step-1/not-listed')
	expect(agentHrefs).toContain('/onboarding/step-1/chatgpt')
	expect(agentHrefs).not.toContain('/community')
	expect(onboardingAgentPickerPrefetchHrefs('cursor', chooser)).toEqual([])

	const featuredIds = ['notion', 'linear'] as const
	const overflowIds = ['github'] as const
	const serviceHrefs = onboardingServicePickerPrefetchHrefs(
		featuredIds,
		overflowIds,
	)
	const serviceHtml = await renderToString(
		jsx(OnboardingServicePicker, {
			featuredIds,
			overflowIds,
		}),
	)
	expect(chipHrefsFromHtml(serviceHtml, 'onboarding-service-')).toEqual(
		serviceHrefs,
	)
	expect(serviceHrefs).toEqual([
		'/onboarding/step-2/notion',
		'/onboarding/step-2/linear',
		'/onboarding/step-2/github',
		'/onboarding/step-2/google',
		'/onboarding/step-2/slack',
		'/onboarding/step-2/discord',
		'/onboarding/step-2/spotify',
		'/onboarding/step-2/x',
		'/onboarding/step-2/asana',
		'/onboarding/step-2/dropbox',
		'/onboarding/step-2/linkedin',
		'/onboarding/step-2/zoom',
		'/onboarding/step-2/not-listed',
	])
	expect(serviceHrefs).not.toContain('/community')
	expect(serviceHtml).not.toContain('href="/community"')
})

test('picker prefetch hrefs keep the rendered search so redirectTo clicks stay warm', async () => {
	const search = '?redirectTo=%2Faccount'
	const chooser = canonicalOnboardingAgentChooser()
	const agentHrefs = onboardingAgentPickerPrefetchHrefs(null, chooser, search)
	const agentHtml = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			search,
		}),
	)
	expect(chipHrefsFromHtml(agentHtml, 'onboarding-agent-')).toEqual(agentHrefs)
	expect(agentHrefs).toContain(`/onboarding/step-1/cursor${search}`)
	expect(
		onboardingAgentPickerPrefetchHrefs('other', chooser, search)[0],
	).toMatch(/\?redirectTo=%2Faccount$/)

	const featuredIds = ['notion'] as const
	const overflowIds = ['github'] as const
	const serviceHrefs = onboardingServicePickerPrefetchHrefs(
		featuredIds,
		overflowIds,
		search,
	)
	const serviceHtml = await renderToString(
		jsx(OnboardingServicePicker, {
			featuredIds,
			overflowIds,
			search,
		}),
	)
	expect(chipHrefsFromHtml(serviceHtml, 'onboarding-service-')).toEqual(
		serviceHrefs,
	)
	expect(serviceHrefs[0]).toBe(`/onboarding/step-2/notion${search}`)
})
