import { type Handle, type RemixNode } from 'remix/ui'
import { routerEvents } from './client-router.tsx'

export type RouterLocationValue = {
	url: string
	ssrUrl: string
}

function getClientUrl() {
	if (typeof window === 'undefined') return '/'
	return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

export function RouterLocationProvider(
	handle: Handle<{ url: string; children?: RemixNode }, RouterLocationValue>,
) {
	const ssrUrl = handle.props.url
	let currentUrl = ssrUrl

	if (typeof window !== 'undefined') {
		handle.queueTask(() => {
			currentUrl = getClientUrl()
			handle.context.set({ url: currentUrl, ssrUrl })
			handle.update()
		})

		routerEvents.addEventListener(
			'navigate',
			() => {
				const nextUrl = getClientUrl()
				if (nextUrl === currentUrl) return
				currentUrl = nextUrl
				handle.context.set({ url: currentUrl, ssrUrl })
				handle.update()
			},
			{ signal: handle.signal },
		)
	}

	handle.context.set({ url: currentUrl, ssrUrl })

	return () => handle.props.children
}

function readRouterLocation(
	handle: Pick<Handle, 'context'>,
): RouterLocationValue {
	const location = handle.context.get(RouterLocationProvider)
	if (location) return location
	// Vite HMR can swap the provider function identity so `context.get`
	// returns undefined mid-render (KODY-6T / KODY-6Z). Fall back to the
	// current client URL instead of throwing.
	const url = getClientUrl()
	return { url, ssrUrl: url }
}

export function readRouterUrl(handle: Pick<Handle, 'context'>) {
	return readRouterLocation(handle).url
}

export function readSsrRouterUrl(handle: Pick<Handle, 'context'>) {
	return readRouterLocation(handle).ssrUrl
}

export function readRouterPathname(handle: Pick<Handle, 'context'>) {
	return new URL(readRouterUrl(handle), 'https://kody.local').pathname
}

export function readRouterSearch(handle: Pick<Handle, 'context'>) {
	return new URL(readRouterUrl(handle), 'https://kody.local').search
}
