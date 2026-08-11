import { expect, test, vi } from 'vitest'
import { registerPrompts } from './register-prompts.ts'

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
	expect(registerPrompt.mock.calls.map((call) => call[0])).toEqual([
		'onboarding_setup',
		'onboarding_discovery',
		'onboarding_first_win',
	])

	for (const call of registerPrompt.mock.calls) {
		const result = await call[2]!()
		expect(result.messages).toEqual([
			{
				role: 'user',
				content: {
					type: 'text',
					text: expect.any(String),
				},
			},
		])
		expect(result.messages[0]?.content.text.length).toBeGreaterThan(0)
	}
})
