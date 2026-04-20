import { expect, test } from 'vitest'
import {
	buildFacetClassExportName,
	buildFacetName,
} from './app-runner-facet-names.ts'

test('facet names normalize blank values and keep export names stable', () => {
	expect(buildFacetName(undefined)).toBe('main')
	expect(buildFacetName(null)).toBe('main')
	expect(buildFacetName('  ')).toBe('main')
	expect(buildFacetName(' reports ')).toBe('reports')
	expect(buildFacetClassExportName('main')).toBe('App')
	expect(buildFacetClassExportName(' main ')).toBe('App')
	expect(buildFacetClassExportName('')).toBe('App')
	expect(buildFacetClassExportName('foo-bar')).not.toBe(
		buildFacetClassExportName('foo_bar'),
	)
})
