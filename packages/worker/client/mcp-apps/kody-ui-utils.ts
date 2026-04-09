import {
	whenKodyWidgetReady,
	type KodyWidgetPublicApi,
} from './kody-widget-runtime.ts'

await import('./kody-ui-runtime.ts')

export type { KodyWidgetPublicApi } from './kody-widget-runtime.ts'

export const kodyWidget: KodyWidgetPublicApi = await whenKodyWidgetReady()
