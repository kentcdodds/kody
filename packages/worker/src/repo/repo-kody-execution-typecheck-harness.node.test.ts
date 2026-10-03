import { expect, test } from 'vitest'
import {
	createRepoCapabilitiesModuleTypecheckHarness,
	mapRepoCapabilitiesModuleTypecheckHarnessLines,
} from './repo-kody-execution.ts'

test('createRepoCapabilitiesModuleTypecheckHarness covers every callable in one program', () => {
	const entryPoints = ['src/job-a.ts', 'src/job-b.ts', 'src/on-email.ts']
	const harness = createRepoCapabilitiesModuleTypecheckHarness({ entryPoints })
	const lineMap = mapRepoCapabilitiesModuleTypecheckHarnessLines({
		entryPoints,
	})
	const lines = harness.split('\n')

	// Line map points at the import and check lines for each entry.
	expect(lineMap.size).toBe(entryPoints.length * 2)
	for (const [line, entryPoint] of lineMap) {
		const entryIndex = entryPoints.indexOf(entryPoint)
		expect(lines[line]).toContain(`userEntrypoint${entryIndex}`)
	}
})
