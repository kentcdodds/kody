#!/usr/bin/env node
/**
 * Validate the primitives taxonomy:
 * - parses
 * - unique ids
 * - every code/docs path resolves on disk
 * - summaries stay single-line and short (no feature-changelog essays)
 */
import {
	checkPrimitivesMapPaths,
	defaultMapPath,
	loadPrimitivesMap,
} from './primitives-map.mjs'

const maxSummaryLength = 120
const map = loadPrimitivesMap()
/** @type {Array<string>} */
const errors = []

const primitiveIds = new Set()
for (const primitive of map.primitives) {
	if (primitiveIds.has(primitive.id)) {
		errors.push(`duplicate primitive id: ${primitive.id}`)
	}
	primitiveIds.add(primitive.id)
	if (!primitive.name?.trim()) {
		errors.push(`primitive ${primitive.id} missing name`)
	}
	if (!primitive.group?.trim()) {
		errors.push(`primitive ${primitive.id} missing group`)
	}
	if (!primitive.summary?.trim()) {
		errors.push(`primitive ${primitive.id} missing summary`)
	} else if (primitive.summary.length > maxSummaryLength) {
		errors.push(
			`primitive ${primitive.id} summary is ${primitive.summary.length} chars (max ${maxSummaryLength}); put detail in docs`,
		)
	}
	if (/\n/.test(primitive.summary ?? '')) {
		errors.push(`primitive ${primitive.id} summary must be a single line`)
	}
}

const invariantIds = new Set()
for (const invariant of map.invariants) {
	if (invariantIds.has(invariant.id)) {
		errors.push(`duplicate invariant id: ${invariant.id}`)
	}
	invariantIds.add(invariant.id)
	if (!invariant.summary?.trim()) {
		errors.push(`invariant ${invariant.id} missing summary`)
	} else if (invariant.summary.length > maxSummaryLength) {
		errors.push(
			`invariant ${invariant.id} summary is ${invariant.summary.length} chars (max ${maxSummaryLength}); put detail in docs`,
		)
	}
}

for (const issue of checkPrimitivesMapPaths(map)) {
	errors.push(`${issue.kind} ${issue.id}: ${issue.path} (${issue.reason})`)
}

if (errors.length > 0) {
	console.error(`primitives map check failed (${defaultMapPath}):`)
	for (const error of errors) {
		console.error(`  - ${error}`)
	}
	process.exit(1)
}

console.log(
	`primitives map ok: ${map.primitives.length} primitives, ${map.invariants.length} invariants`,
)
