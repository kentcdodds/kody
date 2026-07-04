import { clientEntry, type EntryComponent, type Handle } from 'remix/ui'
import { App } from './app.tsx'
import { RouterLocationProvider } from './router-location.tsx'
import { type SessionInfo } from './session.ts'
import { type AppLoaderData } from '#app/loader-data.ts'

export const APP_ROOT_ENTRY_ID = '/client-entry.js#AppRoot'

export type AppRootProps = {
	url: string
	session: SessionInfo | null
	loaderData?: AppLoaderData
	notFound?: boolean
}

export const AppRoot: EntryComponent<AppRootProps> = clientEntry(
	APP_ROOT_ENTRY_ID,
	function AppRoot(handle: Handle<AppRootProps>) {
		return () => (
			<RouterLocationProvider url={handle.props.url}>
				<App
					embeddedSession={handle.props.session}
					loaderData={handle.props.loaderData}
					notFound={handle.props.notFound === true}
				/>
			</RouterLocationProvider>
		)
	},
)
