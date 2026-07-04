import { run } from 'remix/ui'
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
})

app.addEventListener('error', (event) => {
	console.error('Client hydration error:', event.error)
})

void app.ready()
