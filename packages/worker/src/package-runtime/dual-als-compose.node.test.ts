import { expect, test } from 'vitest'
import {
	createRuntimeModuleReexportSource,
	createRuntimeModuleSource,
	refreshKodyRuntimeModules,
} from './runtime-source-modules.ts'
import { materializePublishedArtifactModules } from './module-graph-artifacts.ts'

test('compose artifact then canonical refresh leaves one full runtime', () => {
	const prefix = 'artifacts/pkg/.__published__/deadbeef'
	const artRuntime = `${prefix}/.__kody_virtual__/runtime.js`
	const materialized = materializePublishedArtifactModules({
		artifactPrefix: prefix,
		modules: {
			'.__kody_virtual__/runtime.js': 'stale',
			'wake.js':
				'import { packageSecrets } from "./.__kody_virtual__/runtime.js"; export default async function wake(){ return null }',
		},
	})
	expect(materialized[artRuntime]).toBe(createRuntimeModuleSource())

	const composed = refreshKodyRuntimeModules({
		'.__kody_virtual__/runtime.js': 'stale-canonical',
		'entry.js': `import wake from "./${prefix}/wake.js"; export default async () => wake()`,
		...materialized,
	})
	const full = createRuntimeModuleSource()
	const fullPaths = Object.entries(composed)
		.filter(([, source]) => source === full)
		.map(([path]) => path)
	expect(fullPaths).toEqual(['.__kody_virtual__/runtime.js'])
	expect(composed[artRuntime]).toBe(
		createRuntimeModuleReexportSource(artRuntime),
	)
})
