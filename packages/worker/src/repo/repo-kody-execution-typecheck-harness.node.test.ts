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

	expect(harness).toContain('import userEntrypoint0 from "./src/job-a"')
	expect(harness).toContain('import userEntrypoint1 from "./src/job-b"')
	expect(harness).toContain('import userEntrypoint2 from "./src/on-email"')
	expect(harness).toContain('__kodyTypecheckModule(userEntrypoint0);')
	expect(harness).toContain('__kodyTypecheckModule(userEntrypoint1);')
	expect(harness).toContain('__kodyTypecheckModule(userEntrypoint2);')

	// Line map points at the import and check lines for each entry.
	expect([...lineMap.values()]).toEqual([...entryPoints, ...entryPoints])
	for (const [line, entryPoint] of lineMap) {
		const entryIndex = entryPoints.indexOf(entryPoint)
		expect(lines[line]).toContain(`userEntrypoint${entryIndex}`)
	}
})
