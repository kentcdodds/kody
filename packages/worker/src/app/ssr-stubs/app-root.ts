import { type AppLoaderData } from '#universal/loader-data.ts'
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
	unauthorized?: boolean
}

export const AppRoot = null as unknown as EntryComponent<AppRootProps>
