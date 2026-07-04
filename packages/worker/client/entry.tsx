import { run } from 'remix/ui'
import { REMIX_FRAME_TARGET_HEADER } from '#app/frame-constants.ts'
import { AppRoot, APP_ROOT_ENTRY_ID } from './app-root.tsx'

const clientRegistry: Record<string, typeof AppRoot> = {
	AppRoot,
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
})

void app.ready()
