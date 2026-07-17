import { expect, test } from 'vitest'
import {
	checkPrimitivesMapPaths,
	classifyPaths,
	loadPrimitivesMap,
	parsePrimitivesMap,
	pathMatchesRoot,
} from './primitives-map.mjs'

test('parsePrimitivesMap reads taxonomy fields', () => {
	const map = parsePrimitivesMap(`
version: 1
groups:
  - id: auth
    name: Identity & auth
primitives:
  - id: app-sessions
    group: auth
    name: Browser sessions
    summary: Cookie sessions and signup.
    code:
      - packages/worker/src/app/handlers/auth.ts
    docs:
      - docs/contributing/architecture/authentication.md
invariants:
  - id: per-user-isolation
    summary: userId scopes every path.
`)
	expect(map.version).toBe(1)
	expect(map.groups).toEqual([{ id: 'auth', name: 'Identity & auth' }])
	expect(map.primitives).toHaveLength(1)
	expect(map.primitives[0]).toMatchObject({
		id: 'app-sessions',
		group: 'auth',
		name: 'Browser sessions',
		summary: 'Cookie sessions and signup.',
		code: ['packages/worker/src/app/handlers/auth.ts'],
		docs: ['docs/contributing/architecture/authentication.md'],
	})
	expect(map.invariants[0]?.id).toBe('per-user-isolation')
})

test('pathMatchesRoot distinguishes directory roots from prefix roots', () => {
	expect(
		pathMatchesRoot(
			'packages/worker/src/app/handlers/auth.ts',
			'packages/worker/src/app/',
		),
	).toBe(true)
	expect(
		pathMatchesRoot('packages/worker/src/apple.ts', 'packages/worker/src/app/'),
	).toBe(false)
	expect(
		pathMatchesRoot(
			'packages/worker/src/app/oauth-providers.ts',
			'packages/worker/src/app/oauth-',
		),
	).toBe(true)
	expect(
		pathMatchesRoot(
			'packages/worker/src/mcp-auth.ts',
			'packages/worker/src/mcp/',
		),
	).toBe(false)
})

test('classifyPaths uses longest-prefix match', () => {
	const map = parsePrimitivesMap(`
version: 1
groups:
  - id: surfaces
    name: Entry points
  - id: assistant
    name: Assistant
primitives:
  - id: mcp-server
    group: surfaces
    name: MCP endpoint
    summary: MCP server.
    code:
      - packages/worker/src/mcp/
  - id: saved-packages
    group: assistant
    name: Saved packages
    summary: Packages.
    code:
      - packages/worker/src/mcp/capabilities/packages/
`)
	const { matched, unmatched } = classifyPaths(
		[
			'packages/worker/src/mcp/capabilities/packages/save.ts',
			'packages/worker/src/mcp/index.ts',
			'README.md',
		],
		map,
	)
	expect(unmatched).toEqual(['README.md'])
	expect(matched.map((entry) => entry.primitive.id).sort()).toEqual([
		'mcp-server',
		'saved-packages',
	])
	const packages = matched.find(
		(entry) => entry.primitive.id === 'saved-packages',
	)
	expect(packages?.files).toEqual([
		'packages/worker/src/mcp/capabilities/packages/save.ts',
	])
})

test('parsePrimitivesMap accepts oxfmt-folded summary lines', () => {
	const map = parsePrimitivesMap(`
version: 1
groups:
  - id: auth
    name: Auth
primitives:
  - id: example
    group: auth
    name: Example
    summary:
      Folded onto the next indented line.
invariants: []
`)
	expect(map.primitives[0]?.summary).toBe('Folded onto the next indented line.')
})

test('committed primitives map passes path checks', () => {
	const map = loadPrimitivesMap()
	expect(map.primitives.length).toBeGreaterThan(10)
	expect(checkPrimitivesMapPaths(map)).toEqual([])
})
