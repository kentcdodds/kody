import { expect, test } from 'vitest'
import { isRouteLoaderRedirect } from '#client/route-loader.ts'
import { onboardingRouteLoader } from './onboarding.tsx'
import {
	clearOnboardingAgentChooserSession,
	onboardingAgentChooserSessionKey,
	readRememberedOnboardingAgentChooser,
	rememberOnboardingAgentChooser,
	resolveOnboardingAgentChooser,
} from './onboarding-agent-chooser-session.ts'
import {
	pickOnboardingAgentChooser,
	type OnboardingAgentChooserPick,
} from './onboarding-mcp-clients.ts'
import {
	clearOnboardingPayloadCache,
	type OnboardingPayload,
} from './onboarding-payload.ts'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalSessionStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	'sessionStorage',
)

function restoreBrowserStubs() {
	clearOnboardingAgentChooserSession()
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
	clearOnboardingAgentChooserSession()
	return store
}

const anonymousOnboardingPayload = {
	ok: true,
	loggedIn: false,
	username: null,
	mcpServerUrl: 'https://example.com/mcp',
	setupPrompt: '',
	discoveryPrompt: '',
	persistPrompt: '',
	hasAccessWin: false,
	hasSecondMcpClient: false,
	hasMcpClient: false,
	emailVerified: false,
	needsOnboarding: true,
	featuredListings: [],
	featuredMcpServers: [],
	customMcpServers: [],
	persistedPackageName: null,
	accessWinMemorySubject: null,
	checklist: null,
} satisfies OnboardingPayload

async function loadSelectionStep(pathname = '/onboarding/step-1') {
	const originalFetch = globalThis.fetch
	clearOnboardingPayloadCache()
	globalThis.fetch = (async () =>
		Response.json(anonymousOnboardingPayload)) as typeof fetch
	try {
		return await onboardingRouteLoader(
			new URL(`https://example.com${pathname}`),
			new AbortController().signal,
		)
	} finally {
		globalThis.fetch = originalFetch
		clearOnboardingPayloadCache()
	}
}

function chooserFromLoader(
	result: Awaited<ReturnType<typeof onboardingRouteLoader>>,
): OnboardingAgentChooserPick {
	if (isRouteLoaderRedirect(result) || !result.onboardingAgentChooser) {
		throw new Error('expected onboarding agent chooser loader data')
	}
	return result.onboardingAgentChooser
}

test('client loads of the selection step reuse the SSR agent order', async () => {
	const store = installBrowserSession()
	try {
		const ssrPick = pickOnboardingAgentChooser(() => 0)
		const otherPick = pickOnboardingAgentChooser((max) => Math.max(0, max - 1))
		expect(ssrPick.desktopFeatured).not.toEqual(otherPick.desktopFeatured)
		expect(ssrPick.mobileFeatured).not.toEqual(otherPick.mobileFeatured)

		rememberOnboardingAgentChooser(ssrPick)
		expect(readRememberedOnboardingAgentChooser()).toEqual(ssrPick)
		expect(
			JSON.parse(store.get(onboardingAgentChooserSessionKey) ?? 'null'),
		).toEqual(ssrPick)

		const first = chooserFromLoader(await loadSelectionStep())
		const afterSelect = chooserFromLoader(
			await loadSelectionStep('/onboarding/step-1/cursor'),
		)
		const afterChangeSelection = chooserFromLoader(await loadSelectionStep())
		const indexRedirect = await loadSelectionStep('/onboarding?redirectTo=%2F')
		expect(isRouteLoaderRedirect(indexRedirect)).toBe(true)
		if (isRouteLoaderRedirect(indexRedirect)) {
			expect(indexRedirect.to).toBe('/onboarding/step-1?redirectTo=%2F')
		}
		expect(first).toEqual(ssrPick)
		expect(afterSelect).toEqual(ssrPick)
		expect(afterChangeSelection).toEqual(ssrPick)
		expect(
			resolveOnboardingAgentChooser((max) => Math.max(0, max - 1)),
		).toEqual(ssrPick)
	} finally {
		restoreBrowserStubs()
	}
})

test('onboarding agent chooser session ignores invalid storage and does not persist on the server', () => {
	installBrowserSession()
	try {
		sessionStorage.setItem(onboardingAgentChooserSessionKey, '{"nope":true}')
		expect(readRememberedOnboardingAgentChooser()).toBeNull()
		const first = resolveOnboardingAgentChooser(() => 0)
		const reshuffle = pickOnboardingAgentChooser((max) => Math.max(0, max - 1))
		expect(first.desktopFeatured).not.toEqual(reshuffle.desktopFeatured)
		expect(
			resolveOnboardingAgentChooser((max) => Math.max(0, max - 1)),
		).toEqual(first)
	} finally {
		restoreBrowserStubs()
	}

	const serverPick = pickOnboardingAgentChooser(() => 0)
	rememberOnboardingAgentChooser(serverPick)
	expect(readRememberedOnboardingAgentChooser()).toBeNull()
})
