import { expect, test } from 'vitest'
import {
	buildFacetClassExportName,
	buildFacetName,
} from './app-runner-facet-names.ts'

test('buildFacetName defaults blank values to main', () => {
	expect(buildFacetName(undefined)).toBe('main')
	expect(buildFacetName(null)).toBe('main')
	expect(buildFacetName('  ')).toBe('main')
	expect(buildFacetName(' reports ')).toBe('reports')
})

test('buildFacetClassExportName keeps main facet stable', () => {
	expect(buildFacetClassExportName('main')).toBe('App')
})

test('buildFacetClassExportName stays unique for colliding sanitized names', () => {
	expect(buildFacetClassExportName('foo-bar')).not.toBe(
		buildFacetClassExportName('foo_bar'),
	)
})
