import { expect, test } from 'vitest'
import {
	clearOnboardingSelectedAgentSession,
	onboardingSelectedAgentSessionKey,
	readRememberedOnboardingSelectedAgent,
	rememberOnboardingSelectedAgent,
} from './onboarding-selected-agent-session.ts'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalSessionStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	'sessionStorage',
)

function restoreBrowserStubs() {
	clearOnboardingSelectedAgentSession()
	if (originalWindow) {
		Object.defineProperty(globalThis, 'window', originalWindow)
	} else {
		Reflect.deleteProperty(globalThis, 'window')
	}
	if (originalSessionStorage) {
		Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage)
	} else {
		Reflect.deleteProperty(globalThis, 'sessionStorage')
	}
}

function installBrowserSession() {
	const store = new Map<string, string>()
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: globalThis,
	})
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		value: {
			getItem(key: string) {
				return store.get(key) ?? null
			},
			setItem(key: string, value: string) {
				store.set(key, value)
			},
			removeItem(key: string) {
				store.delete(key)
			},
		},
	})
	clearOnboardingSelectedAgentSession()
	return store
}

test('step 1 agent choice is remembered for step 2, but not-listed is not', () => {
	const store = installBrowserSession()
	try {
		expect(readRememberedOnboardingSelectedAgent()).toBeNull()
		rememberOnboardingSelectedAgent('other')
		expect(readRememberedOnboardingSelectedAgent()).toBeNull()
		expect(store.get(onboardingSelectedAgentSessionKey)).toBeUndefined()

		rememberOnboardingSelectedAgent('cursor')
		expect(readRememberedOnboardingSelectedAgent()).toBe('cursor')
		expect(store.get(onboardingSelectedAgentSessionKey)).toBe('cursor')

		rememberOnboardingSelectedAgent('chatgpt')
		expect(readRememberedOnboardingSelectedAgent()).toBe('chatgpt')

		// Opening Not listed is the overflow picker, not a new first agent.
		rememberOnboardingSelectedAgent('other')
		expect(readRememberedOnboardingSelectedAgent()).toBe('chatgpt')
		expect(store.get(onboardingSelectedAgentSessionKey)).toBe('chatgpt')
	} finally {
		restoreBrowserStubs()
	}
})
