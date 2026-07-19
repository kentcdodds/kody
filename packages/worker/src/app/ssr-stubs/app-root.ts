import { type AppLoaderData } from '#app/loader-data.ts'
import { type EntryComponent } from 'remix/ui'

export type AppRootProps = {
	url: string
	session: {
		email: string
		username: string
		roles: Array<string>
		permissions: Array<string>
		featureFlags: Record<string, boolean>
	} | null
	loaderData?: AppLoaderData
	notFound?: boolean
}

export const APP_ROOT_ENTRY_ID = '/client-entry.js#AppRoot'
export const AppRoot = null as unknown as EntryComponent<AppRootProps>
