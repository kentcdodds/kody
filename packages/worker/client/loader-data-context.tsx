import { type Handle, type RemixNode } from 'remix/ui'
import { type AppLoaderData } from '#client/loader-data-types.ts'

export type AppLoaderDataContextValue = {
	loaderData?: AppLoaderData
}

export function AppLoaderDataProvider(
	handle: Handle<
		{ loaderData?: AppLoaderData; children?: RemixNode },
		AppLoaderDataContextValue
	>,
) {
	handle.context.set({ loaderData: handle.props.loaderData })

	return () => handle.props.children
}

export function readAppLoaderData(handle: Handle) {
	return handle.context.get(AppLoaderDataProvider).loaderData
}
