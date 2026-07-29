import { run } from 'remix/ui'
import { REMIX_FRAME_TARGET_HEADER } from '#app/frame-constants.ts'
import { consumePrefetchedFrame } from '#client/frame-prefetch.ts'
import { preloadClientRouteModules } from '#client/lazy-route.tsx'
import {
	captureClientException,
	initSentryClient,
} from '#client/sentry-client.ts'
import { AppRoot, APP_ROOT_ENTRY_ID } from './app-root.tsx'

initSentryClient(document)

const clientRegistry: Record<string, typeof AppRoot> = {
	AppRoot,
}

async function boot() {
	// `run()` starts hydration immediately; `app.ready()` only waits for it to
	// finish. Warm the current route chunk first so LazyRoute sees a hot cache
	// during hydration and matches SSR DOM.
	try {
		await preloadClientRouteModules(
			`${window.location.pathname}${window.location.search}`,
		)
	} catch (error: unknown) {
		// Still hydrate: LazyRoute will retry the import. A hard chunk miss may
		// leave a brief empty route, which is better than never booting.
		console.error('Client route preload failed:', error)
	}

	const app = run({
		loadModule(moduleUrl, exportName) {
			const expectedHref = APP_ROOT_ENTRY_ID.split('#')[0]
			if (moduleUrl !== expectedHref) {
				throw new Error(`Unknown client module URL: ${moduleUrl}`)
			}
			const component = clientRegistry[exportName]
			if (!component) {
				throw new Error(`Unknown client export: ${exportName}`)
			}
			return component
		},
		async resolveFrame(src, signal, target) {
			const cached = consumePrefetchedFrame(src, target)
			if (cached !== undefined) {
				return cached
			}
			const headers = new Headers({ Accept: 'text/html' })
			if (target) {
				headers.set(REMIX_FRAME_TARGET_HEADER, target)
			}
			const response = await fetch(src, { headers, signal })
			if (!response.ok) {
				throw new Error(
					`Frame resolve failed (${response.status}) for ${src}${target ? ` target=${target}` : ''}`,
				)
			}
			return response.body ?? (await response.text())
		},
	})

	app.addEventListener('error', (event) => {
		console.error('Client hydration error:', event.error)
		captureClientException(event.error)
	})

	await app.ready()
}

void boot().catch((error: unknown) => {
	console.error('Client boot failed:', error)
	captureClientException(error)
})
