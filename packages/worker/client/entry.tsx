import { run } from 'remix/ui'
import { consumePrefetchedFrame } from '#client/frame-prefetch.ts'
import {
	createFrameResolveInit,
	prefetchedFrameResponse,
} from '#client/frame-resolve.ts'
import { preloadClientRouteModules } from '#client/lazy-route.tsx'
import {
	captureClientException,
	initSentryClient,
} from '#client/sentry-client.ts'
import { AppRoot, APP_ROOT_ENTRY_ID } from './app-root.tsx'
import { ensureCryptoRandomUUID } from './ensure-crypto-random-uuid.ts'

// Remix frame ids call crypto.randomUUID(); some in-app browsers omit it.
ensureCryptoRandomUUID()
initSentryClient(document)

const clientRegistry: Record<string, typeof AppRoot> = {
	AppRoot,
}

const bootChunkReloadFlag = 'kody:boot-chunk-reload'

async function boot() {
	// `run()` starts hydration immediately; `app.ready()` only waits for it to
	// finish. Warm the current route chunk first so LazyRoute sees a hot cache
	// during hydration and matches SSR DOM.
	try {
		await preloadClientRouteModules(
			`${window.location.pathname}${window.location.search}`,
		)
		try {
			sessionStorage.removeItem(bootChunkReloadFlag)
		} catch {
			// Storage may be unavailable (private mode); the flag is best-effort.
		}
	} catch (error: unknown) {
		console.error('Client route preload failed:', error)
		// A stale cached entry referencing rotated chunk hashes cannot hydrate
		// this route. One forced reload fetches a fresh document (HTML is
		// no-store) whose entry href points at the current build; the flag
		// prevents a reload loop when the chunk is genuinely missing.
		try {
			if (!sessionStorage.getItem(bootChunkReloadFlag)) {
				sessionStorage.setItem(bootChunkReloadFlag, '1')
				window.location.reload()
				return
			}
		} catch {
			// Storage unavailable: fall through and hydrate anyway.
		}
		// Still hydrate: LazyRoute will retry the import. A hard chunk miss may
		// leave a brief empty route, which is better than never booting.
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
		async resolveFrame(src, options) {
			const target = options?.target
			const method = options?.method?.trim().toUpperCase()
			const cached =
				method === 'HEAD' ? undefined : consumePrefetchedFrame(src, target)
			if (cached !== undefined) {
				return prefetchedFrameResponse(cached)
			}
			const response = await fetch(src, createFrameResolveInit(options))
			if (!response.ok) {
				throw new Error(
					`Frame resolve failed (${response.status}) for ${src}${target ? ` target=${target}` : ''}`,
				)
			}
			return response
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
