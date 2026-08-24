import {
	mcpOAuthChannelName,
	mcpOAuthMessageType,
	mcpOAuthPopupName,
	mcpOAuthReturnCookie,
	mcpOAuthReturnOnboarding,
	readMcpOAuthDoneMessage,
	type McpOAuthDoneMessage,
} from '#universal/mcp-oauth-return.ts'

export { mcpOAuthMessageType }

function isOnboardingMcpOAuthPopup() {
	return typeof window !== 'undefined' && window.name === mcpOAuthPopupName
}

function readAuthOutcomeFromLocation(): Omit<McpOAuthDoneMessage, 'type'> {
	const params = new URLSearchParams(window.location.search)
	return {
		auth: params.get('auth'),
		reason: params.get('reason'),
		server: params.get('server'),
	}
}

function publishOnboardingMcpOAuthDone(outcome: McpOAuthDoneMessage) {
	try {
		const channel = new BroadcastChannel(mcpOAuthChannelName)
		channel.postMessage(outcome)
		channel.close()
	} catch {
		// BroadcastChannel is missing in some embeds; postMessage still runs.
	}
	if (typeof window === 'undefined') return
	if (!window.opener || window.opener.closed) return
	window.opener.postMessage(outcome, window.location.origin)
}

/**
 * Remember that this authorize flow started on onboarding, then open the
 * provider page in a named popup so the callback tab can close itself.
 * `window.name` survives provider COOP, which often severs `window.opener`.
 */
export function openOnboardingMcpOAuthPopup(authUrl: string) {
	document.cookie = mcpOAuthReturnCookie({
		value: mcpOAuthReturnOnboarding,
		secure: window.location.protocol === 'https:',
	})
	const popup = window.open(
		authUrl,
		mcpOAuthPopupName,
		'popup,width=560,height=780',
	)
	if (popup == null) {
		window.location.assign(authUrl)
	}
}

/** Drop the onboarding return marker so a later account authorize stays put. */
export function clearOnboardingMcpOAuthReturnCookie() {
	document.cookie = mcpOAuthReturnCookie({
		value: '',
		secure: window.location.protocol === 'https:',
	})
}

/**
 * Close the authorize popup after callback. Always notify the opener (or
 * any same-origin tab) so Step 2 can flip to Connected or show the error.
 */
export function closeOnboardingMcpOAuthPopupIfOpened() {
	if (!isOnboardingMcpOAuthPopup()) return false
	publishOnboardingMcpOAuthDone({
		type: mcpOAuthMessageType,
		...readAuthOutcomeFromLocation(),
	})
	window.close()
	return true
}

export function listenForOnboardingMcpOAuthDone(
	onDone: (outcome: McpOAuthDoneMessage) => void,
	signal: AbortSignal,
) {
	function handleData(data: unknown) {
		const outcome = readMcpOAuthDoneMessage(data)
		if (!outcome) return
		onDone(outcome)
	}
	function onMessage(event: MessageEvent) {
		if (event.origin !== window.location.origin) return
		handleData(event.data)
	}
	window.addEventListener('message', onMessage, { signal })
	try {
		const channel = new BroadcastChannel(mcpOAuthChannelName)
		channel.addEventListener(
			'message',
			(event) => {
				handleData(event.data)
			},
			{ signal },
		)
		signal.addEventListener('abort', () => channel.close(), { once: true })
	} catch {
		// postMessage listener above is enough when BroadcastChannel is missing.
	}
}
