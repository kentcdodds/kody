import { addEventListeners, type Handle, type RemixNode } from 'remix/ui'
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

		addEventListeners(routerEvents, handle.signal, {
			navigate() {
				const nextUrl = getClientUrl()
				if (nextUrl === currentUrl) return
				currentUrl = nextUrl
				handle.context.set({ url: currentUrl, ssrUrl })
				handle.update()
			},
		})
	}

	handle.context.set({ url: currentUrl, ssrUrl })

	return () => handle.props.children
}

export function readRouterUrl(handle: Pick<Handle, 'context'>) {
	return handle.context.get(RouterLocationProvider).url
}

export function readSsrRouterUrl(handle: Pick<Handle, 'context'>) {
	return handle.context.get(RouterLocationProvider).ssrUrl
}

export function readRouterPathname(handle: Pick<Handle, 'context'>) {
	return new URL(readRouterUrl(handle), 'https://kody.local').pathname
}

export function readRouterSearch(handle: Pick<Handle, 'context'>) {
	return new URL(readRouterUrl(handle), 'https://kody.local').search
}
