import { clientEntry, type EntryComponent, type Handle } from 'remix/ui'
import { App } from './app.tsx'
import { RouterLocationProvider } from './router-location.tsx'
import { type SessionInfo } from './session.ts'
import { type AppLoaderData } from '#universal/loader-data.ts'

export type AppRootProps = {
	url: string
	session: SessionInfo | null
	loaderData?: AppLoaderData
	notFound?: boolean
	unauthorized?: boolean
}

// Remix rc.1 throws when the entry ID is empty. Vite and Node keep the
// source `import.meta.url`; Wrangler/workerd (MCP e2e) leaves it blank.
const appRootEntryId = import.meta.url || '/client-entry.js#AppRoot'

export const AppRoot: EntryComponent<AppRootProps> = clientEntry(
	appRootEntryId,
	function AppRoot(handle: Handle<AppRootProps>) {
		return () => (
			<RouterLocationProvider url={handle.props.url}>
				<App
					embeddedSession={handle.props.session}
					loaderData={handle.props.loaderData}
					notFound={handle.props.notFound === true}
					unauthorized={handle.props.unauthorized === true}
				/>
			</RouterLocationProvider>
		)
	},
)
