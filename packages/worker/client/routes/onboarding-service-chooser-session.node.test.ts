import { expect, test } from 'vitest'
import { isRouteLoaderRedirect } from '#client/route-loader.ts'
import { onboardingRouteLoader } from './onboarding.tsx'
import {
	clearOnboardingServiceChooserSession,
	onboardingServiceChooserSessionKey,
	readRememberedOnboardingServiceChooser,
	rememberOnboardingServiceChooser,
	resolveOnboardingServiceChooser,
} from './onboarding-service-chooser-session.ts'
import {
	pickOnboardingServiceChooser,
	type OnboardingServiceChooserPick,
} from '#universal/onboarding-mcp-chooser.ts'
import { emptyOnboardingSessionMilestones } from '#universal/onboarding-process.ts'
import { type OnboardingPayload } from './onboarding-payload.ts'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalSessionStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	'sessionStorage',
)

function restoreBrowserStubs() {
	clearOnboardingServiceChooserSession()
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
	clearOnboardingServiceChooserSession()
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
	milestones: emptyOnboardingSessionMilestones,
	hasMcpClient: false,
	emailVerified: false,
	needsOnboarding: true,
	featuredListings: [],
	featuredMcpServers: [],
	customMcpServers: [],
	persistedPackageKodyId: null,
	checklist: null,
} satisfies OnboardingPayload

async function loadSelectionStep(pathname = '/onboarding/step-2') {
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async () =>
		Response.json(anonymousOnboardingPayload)) as typeof fetch
	try {
		return await onboardingRouteLoader(
			new URL(`https://example.com${pathname}`),
			new AbortController().signal,
		)
	} finally {
		globalThis.fetch = originalFetch
	}
}

function chooserFromLoader(
	result: Awaited<ReturnType<typeof onboardingRouteLoader>>,
): OnboardingServiceChooserPick {
	if (isRouteLoaderRedirect(result) || !result.onboardingServiceChooser) {
		throw new Error('expected onboarding service chooser loader data')
	}
	return result.onboardingServiceChooser
}

test('client loads of step 2 reuse the SSR MCP order', async () => {
	const store = installBrowserSession()
	try {
		const ssrPick = pickOnboardingServiceChooser(() => 0)
		const otherPick = pickOnboardingServiceChooser((max) =>
			Math.max(0, max - 1),
		)
		expect(ssrPick.featured).not.toEqual(otherPick.featured)

		rememberOnboardingServiceChooser(ssrPick)
		expect(readRememberedOnboardingServiceChooser()).toEqual(ssrPick)
		expect(
			JSON.parse(store.get(onboardingServiceChooserSessionKey) ?? 'null'),
		).toEqual(ssrPick)

		const first = chooserFromLoader(await loadSelectionStep())
		const afterSelect = chooserFromLoader(
			await loadSelectionStep('/onboarding/step-2/notion'),
		)
		const afterChangeSelection = chooserFromLoader(await loadSelectionStep())
		expect(first).toEqual(ssrPick)
		expect(afterSelect).toEqual(ssrPick)
		expect(afterChangeSelection).toEqual(ssrPick)
		expect(
			resolveOnboardingServiceChooser((max) => Math.max(0, max - 1)),
		).toEqual(ssrPick)
	} finally {
		restoreBrowserStubs()
	}
})

test('onboarding service chooser session ignores invalid storage and does not persist on the server', () => {
	installBrowserSession()
	try {
		sessionStorage.setItem(onboardingServiceChooserSessionKey, '{"nope":true}')
		expect(readRememberedOnboardingServiceChooser()).toBeNull()
		const first = resolveOnboardingServiceChooser(() => 0)
		const reshuffle = pickOnboardingServiceChooser((max) =>
			Math.max(0, max - 1),
		)
		expect(first.featured).not.toEqual(reshuffle.featured)
		expect(
			resolveOnboardingServiceChooser((max) => Math.max(0, max - 1)),
		).toEqual(first)
	} finally {
		restoreBrowserStubs()
	}

	const serverPick = pickOnboardingServiceChooser(() => 0)
	rememberOnboardingServiceChooser(serverPick)
	expect(readRememberedOnboardingServiceChooser()).toBeNull()
})
