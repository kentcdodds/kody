export const honeypotFieldName = 'website'
export const turnstileResponseFieldName = 'turnstileToken'
export const turnstileWidgetClassName = 'kody-turnstile'

type TurnstileApi = {
	render(
		container: HTMLElement,
		options: { sitekey: string; 'response-field-name': string },
	): string
	reset?(container: HTMLElement | string): void
	remove?(container: HTMLElement | string): void
}

let turnstileScriptPromise: Promise<TurnstileApi> | null = null

function getTurnstileApi() {
	return (window as typeof window & { turnstile?: TurnstileApi }).turnstile
}

function loadTurnstileScript() {
	const existingApi = getTurnstileApi()
	if (existingApi) return Promise.resolve(existingApi)
	if (turnstileScriptPromise) return turnstileScriptPromise

	turnstileScriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
		const existingScript = document.querySelector<HTMLScriptElement>(
			'script[data-kody-turnstile]',
		)
		const script = existingScript ?? document.createElement('script')
		const handleLoad = () => {
			const api = getTurnstileApi()
			if (api) resolve(api)
			else reject(new Error('Turnstile API did not initialize.'))
		}
		script.addEventListener('load', handleLoad, { once: true })
		script.addEventListener(
			'error',
			() => reject(new Error('Turnstile script failed to load.')),
			{ once: true },
		)
		if (!existingScript) {
			script.src =
				'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
			script.async = true
			script.defer = true
			script.dataset.kodyTurnstile = 'true'
			document.head.append(script)
		}
	})
	return turnstileScriptPromise
}

/**
 * Remix re-renders can wipe Turnstile's injected children from a declarative
 * empty host while leaving our `data-turnstile-rendered` marker. Without this
 * check we skip re-render and later `reset()` throws "Nothing to reset found…".
 * A live widget always leaves at least one child (iframe / response input).
 */
function isTurnstileWidgetAlive(container: HTMLElement) {
	return container.childElementCount > 0
}

function clearTurnstileRenderedMarker(container: HTMLElement) {
	delete container.dataset.turnstileRendered
}

function abandonOrphanedTurnstileWidget(
	api: TurnstileApi,
	container: HTMLElement,
) {
	clearTurnstileRenderedMarker(container)
	try {
		api.remove?.(container)
	} catch {
		// Widget is already gone from Turnstile's registry; ignore.
	}
}

export async function renderTurnstileWidgets(siteKey: string | null) {
	if (!siteKey || typeof document === 'undefined') return
	const api = await loadTurnstileScript()
	for (const container of document.querySelectorAll<HTMLElement>(
		`.${turnstileWidgetClassName}`,
	)) {
		if (container.dataset.turnstileRendered === 'true') {
			if (isTurnstileWidgetAlive(container)) continue
			abandonOrphanedTurnstileWidget(api, container)
		}
		try {
			api.render(container, {
				sitekey: siteKey,
				'response-field-name': turnstileResponseFieldName,
			})
			container.dataset.turnstileRendered = 'true'
		} catch (error) {
			clearTurnstileRenderedMarker(container)
			throw error
		}
	}
}

/**
 * Issue a fresh challenge token. Turnstile tokens are single-use: the server
 * consumes one on every verify, so a form that stays mounted after a failed
 * submit would resubmit a spent token and be rejected for the wrong reason.
 * Call this on any path that leaves the form up for another try.
 *
 * Never throws: a dead/orphaned widget (DOM wiped by a re-render) must not
 * surface as an unhandled rejection from submit handlers. Clear the marker so
 * the next `renderTurnstileWidgets` call can remount.
 */
export function resetTurnstileWidgets() {
	if (typeof document === 'undefined') return
	const api = getTurnstileApi()
	if (!api?.reset) return
	for (const container of document.querySelectorAll<HTMLElement>(
		`.${turnstileWidgetClassName}[data-turnstile-rendered]`,
	)) {
		if (!isTurnstileWidgetAlive(container)) {
			abandonOrphanedTurnstileWidget(api, container)
			continue
		}
		try {
			api.reset(container)
		} catch {
			abandonOrphanedTurnstileWidget(api, container)
		}
	}
}

export function readPublicFormProtection(formData: FormData) {
	return {
		website: String(formData.get(honeypotFieldName) ?? ''),
		turnstileToken: String(formData.get(turnstileResponseFieldName) ?? ''),
	}
}
