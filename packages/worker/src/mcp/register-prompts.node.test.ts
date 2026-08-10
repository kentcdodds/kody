import { expect, test, vi } from 'vitest'
import { registerPrompts } from './register-prompts.ts'
import {
	buildDiscoveryPrompt,
	buildFirstWinPrompt,
	buildOnboardingSetupPrompt,
} from '#worker/onboarding-prompts.ts'

test('registerPrompts advertises the templated onboarding prompts', async () => {
	const registerPrompt = vi.fn()
	const agent = {
		server: { registerPrompt },
		getEnv: () => ({ APP_BASE_URL: 'https://kody.test' }) as Env,
		getCallerContext: () => ({
			baseUrl: 'https://kody.test',
			user: null,
		}),
		requireDomain: () => 'https://kody.test',
		getLoopbackExports: () => ({}) as never,
	}

	await registerPrompts(agent as never)

	expect(registerPrompt).toHaveBeenCalledTimes(3)
	const names = registerPrompt.mock.calls.map((call) => call[0])
	expect(names).toEqual([
		'onboarding_setup',
		'onboarding_discovery',
		'onboarding_first_win',
	])

	const setupResult = await registerPrompt.mock.calls[0]![2]!()
	expect(setupResult).toEqual({
		description: 'Kody onboarding setup prompt',
		messages: [
			{
				role: 'user',
				content: {
					type: 'text',
					text: buildOnboardingSetupPrompt(),
				},
			},
		],
	})

	const discoveryResult = await registerPrompt.mock.calls[1]![2]!()
	expect(discoveryResult.messages[0]?.content).toEqual({
		type: 'text',
		text: buildDiscoveryPrompt({
			env: { APP_BASE_URL: 'https://kody.test' },
			requestUrl: 'https://kody.test',
		}),
	})

	const firstWinResult = await registerPrompt.mock.calls[2]![2]!()
	expect(firstWinResult.messages[0]?.content.text).toBe(
		buildFirstWinPrompt({
			env: { APP_BASE_URL: 'https://kody.test' },
			requestUrl: 'https://kody.test',
		}),
	)
})
