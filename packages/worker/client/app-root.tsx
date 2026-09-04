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

export const AppRoot: EntryComponent<AppRootProps> = clientEntry(
	import.meta.url,
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
