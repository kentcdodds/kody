import {
	mcpOAuthChannelName,
	mcpOAuthMessageType,
	mcpOAuthPopupName,
	mcpOAuthReturnCookie,
	mcpOAuthReturnOnboarding,
} from '#universal/mcp-oauth-return.ts'

export { mcpOAuthMessageType }

function isOnboardingMcpOAuthPopup() {
	if (typeof window === 'undefined') return false
	if (window.name === mcpOAuthPopupName) return true
	return Boolean(window.opener && !window.opener.closed)
}

function publishOnboardingMcpOAuthDone() {
	try {
		const channel = new BroadcastChannel(mcpOAuthChannelName)
		channel.postMessage({ type: mcpOAuthMessageType })
		channel.close()
	} catch {
		// BroadcastChannel is missing in some embeds; postMessage still runs.
	}
	if (typeof window === 'undefined') return
	if (!window.opener || window.opener.closed) return
	window.opener.postMessage(
		{ type: mcpOAuthMessageType },
		window.location.origin,
	)
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

/**
 * Close the authorize popup after callback. Always notify the opener (or
 * any same-origin tab) so Step 2 can flip to Connected without a refresh.
 */
export function closeOnboardingMcpOAuthPopupIfOpened() {
	if (!isOnboardingMcpOAuthPopup()) return false
	publishOnboardingMcpOAuthDone()
	window.close()
	return true
}

export function listenForOnboardingMcpOAuthDone(
	onDone: () => void,
	signal: AbortSignal,
) {
	function onMessage(event: MessageEvent) {
		if (event.origin !== window.location.origin) return
		if (event.data?.type !== mcpOAuthMessageType) return
		onDone()
	}
	window.addEventListener('message', onMessage, { signal })
	try {
		const channel = new BroadcastChannel(mcpOAuthChannelName)
		channel.addEventListener(
			'message',
			(event) => {
				if (event.data?.type !== mcpOAuthMessageType) return
				onDone()
			},
			{ signal },
		)
		signal.addEventListener('abort', () => channel.close(), { once: true })
	} catch {
		// postMessage listener above is enough when BroadcastChannel is missing.
	}
}
