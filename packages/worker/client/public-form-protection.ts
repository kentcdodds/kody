export const honeypotFieldName = 'website'
export const turnstileResponseFieldName = 'turnstileToken'
export const turnstileWidgetClassName = 'kody-turnstile'

type TurnstileApi = {
	render(
		container: HTMLElement,
		options: { sitekey: string; 'response-field-name': string },
	): string
	reset?(container: HTMLElement): void
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

export async function renderTurnstileWidgets(siteKey: string | null) {
	if (!siteKey || typeof document === 'undefined') return
	const api = await loadTurnstileScript()
	for (const container of document.querySelectorAll<HTMLElement>(
		`.${turnstileWidgetClassName}:not([data-turnstile-rendered])`,
	)) {
		container.dataset.turnstileRendered = 'true'
		api.render(container, {
			sitekey: siteKey,
			'response-field-name': turnstileResponseFieldName,
		})
	}
}

/**
 * Issue a fresh challenge token. Turnstile tokens are single-use: the server
 * consumes one on every verify, so a form that stays mounted after a failed
 * submit would resubmit a spent token and be rejected for the wrong reason.
 * Call this on any path that leaves the form up for another try.
 */
export function resetTurnstileWidgets() {
	if (typeof document === 'undefined') return
	const api = getTurnstileApi()
	if (!api?.reset) return
	for (const container of document.querySelectorAll<HTMLElement>(
		`.${turnstileWidgetClassName}[data-turnstile-rendered]`,
	)) {
		api.reset(container)
	}
}

export function readPublicFormProtection(formData: FormData) {
	return {
		website: String(formData.get(honeypotFieldName) ?? ''),
		turnstileToken: String(formData.get(turnstileResponseFieldName) ?? ''),
	}
}
