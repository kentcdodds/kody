import { expect, test } from 'vitest'
// @ts-expect-error - the oxlint plugin is plain JS with no type declarations.
import {
	findImportBoundaryViolation,
	getImportBoundariesForFile,
	importBoundaries,
} from './local-plugin.js'

const mcpFile = 'packages/worker/src/mcp/capabilities/admin/admin-user-get.ts'
const packageRegistryFile = 'packages/worker/src/package-registry/repo.ts'
const appFile = 'packages/worker/src/app/handlers/admin-users.ts'

test('the layer boundaries forbid upward imports and never allow handler imports', () => {
	expect(
		findImportBoundaryViolation(mcpFile, '#worker/admin/users-data.ts'),
	).toBe(null)
	expect(
		findImportBoundaryViolation(mcpFile, '#app/admin-users-data.ts'),
	).toMatch(/#mcp\/\* must not import from #app\/\*/)
	expect(
		findImportBoundaryViolation(mcpFile, '#app/community-public.ts'),
	).toMatch(/#mcp\/\* must not import from #app\/\*/)
	// Public-origin resolution moved to a neutral module, so the app-layer path
	// is no longer allowlisted and the neutral one needs no exception.
	expect(findImportBoundaryViolation(mcpFile, '#app/app-base-url.ts')).toMatch(
		/#mcp\/\* must not import from #app\/\*/,
	)
	expect(findImportBoundaryViolation(mcpFile, '#worker/app-base-url.ts')).toBe(
		null,
	)

	// Request handlers are never allowlistable, even by adding a specifier.
	expect(
		findImportBoundaryViolation(mcpFile, '#app/handlers/admin-users.ts'),
	).toMatch(/must never import an #app\/handlers\/\* request handler/)

	expect(
		findImportBoundaryViolation(
			packageRegistryFile,
			'#worker/vectorize/vector-ids.ts',
		),
	).toBe(null)
	expect(
		findImportBoundaryViolation(
			packageRegistryFile,
			'#mcp/capabilities/vector-ids.ts',
		),
	).toMatch(/#worker\/package-registry\/\* must not import from #mcp\/\*/)
	expect(
		findImportBoundaryViolation(packageRegistryFile, '#mcp/secrets/service.ts'),
	).toMatch(/#worker\/package-registry\/\* must not import from #mcp\/\*/)

	// The app layer sits above both, so it may import downward freely.
	expect(getImportBoundariesForFile(appFile)).toEqual([])
	expect(findImportBoundaryViolation(appFile, '#mcp/secrets/service.ts')).toBe(
		null,
	)

	// Windows-style paths resolve to the same boundaries.
	expect(
		getImportBoundariesForFile(mcpFile.replaceAll('/', '\\')).map(
			(boundary: { id: string }) => boundary.id,
		),
	).toEqual(['mcp-to-app'])
})

test('import boundaries have no legacy exceptions', () => {
	const entries = importBoundaries.flatMap(
		(boundary: {
			allowedSpecifiers: Array<{ specifier: string; reason: string }>
		}) => boundary.allowedSpecifiers,
	)
	expect(entries).toEqual([])
})
