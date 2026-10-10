import { css } from 'remix/component'
import {
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'
import { FeaturesOverview } from './features/overview.tsx'
import { MemoryFeature } from './features/memory.tsx'
import { SecretsFeature } from './features/secrets.tsx'
import { PackagesFeature } from './features/packages.tsx'
import { TriggersFeature } from './features/triggers.tsx'
import { IntegrationsFeature } from './features/integrations.tsx'
import { AppsFeature } from './features/apps.tsx'

const layout = {
	'--feature-max-width': layoutMaxWidths.extended,
	'--feature-gutter': pageGutter,
}

export function FeaturesRoute() {
	return () => (
		<div class="feature-overview" mix={css(layout)}>
			<FeaturesOverview />
		</div>
	)
}
export function MemoryRoute() {
	return () => (
		<div class="feature-detail" mix={css(layout)}>
			<MemoryFeature />
		</div>
	)
}
export function SecretsRoute() {
	return () => (
		<div class="feature-detail" mix={css(layout)}>
			<SecretsFeature />
		</div>
	)
}
export function PackagesRoute() {
	return () => (
		<div class="feature-detail" mix={css(layout)}>
			<PackagesFeature />
		</div>
	)
}
export function TriggersRoute() {
	return () => (
		<div class="feature-detail" mix={css(layout)}>
			<TriggersFeature />
		</div>
	)
}
export function IntegrationsRoute() {
	return () => (
		<div class="feature-detail" mix={css(layout)}>
			<IntegrationsFeature />
		</div>
	)
}
export function AppsRoute() {
	return () => (
		<div class="feature-detail" mix={css(layout)}>
			<AppsFeature />
		</div>
	)
}
