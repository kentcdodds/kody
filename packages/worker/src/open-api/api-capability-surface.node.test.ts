import { expect, test } from 'vitest'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import { formatEntityDetailMarkdown } from '#mcp/tools/search-format-detail.ts'
import {
	capabilityApiAvailabilitySummary,
	isCapabilityAvailableViaApiTool,
	openApiExcludedCapabilities,
	openApiExcludedDomains,
} from './api-capability-surface.ts'
import { apiOperationsById } from './operations.ts'

test('search and api agree on which capabilities api can call', async () => {
	const registry = await getStaticRegistry()
	const executeOnlySamples = [
		'webhookSyntheticDispatch',
		'adminPlatformFeedbackGet',
		'execute',
	]
	for (const name of executeOnlySamples) {
		expect(registry.capabilitySpecs[name]).toBeTruthy()
		expect(isCapabilityAvailableViaApiTool(name)).toBe(false)
		expect(apiOperationsById.has(name)).toBe(false)
		expect(capabilityApiAvailabilitySummary(name).apiAvailable).toBe(false)
		expect(capabilityApiAvailabilitySummary(name).summary).toContain(
			'execute-only',
		)
	}

	expect(isCapabilityAvailableViaApiTool('webhookDeliveryList')).toBe(true)
	expect(isCapabilityAvailableViaApiTool('metaGetCurrentUser')).toBe(true)
	expect(
		capabilityApiAvailabilitySummary('metaGetCurrentUser').summary,
	).toContain('operationId')
})

test('capability entity detail marks execute-only capabilities for search', async () => {
	const registry = await getStaticRegistry()
	for (const name of [
		'webhookSyntheticDispatch',
		'adminPlatformFeedbackGet',
	] as const) {
		const spec = registry.capabilitySpecs[name]
		expect(spec).toBeTruthy()
		const detail = formatEntityDetailMarkdown({
			type: 'capability',
			id: name,
			title: name,
			description: spec!.description,
			spec: spec!,
		})
		expect(detail.markdown).toContain('execute-only')
		expect(detail.markdown).toContain('not available')
		expect(detail.structured).toMatchObject({
			type: 'capability',
			id: name,
			apiAvailable: false,
		})
	}

	const apiCapable = registry.capabilitySpecs['webhookDeliveryList']
	expect(apiCapable).toBeTruthy()
	const apiDetail = formatEntityDetailMarkdown({
		type: 'capability',
		id: 'webhookDeliveryList',
		title: 'webhookDeliveryList',
		description: apiCapable!.description,
		spec: apiCapable!,
	})
	expect(apiDetail.markdown).toContain('operationId `webhookDeliveryList`')
	expect(apiDetail.structured).toMatchObject({
		type: 'capability',
		apiAvailable: true,
	})
})

test('every registry capability outside the exclusion lists is on the Open API', async () => {
	const registry = await getStaticRegistry()
	const missing = registry.capabilityList
		.filter(
			(capability) =>
				!openApiExcludedDomains.has(capability.domain) &&
				!openApiExcludedCapabilities.has(capability.name) &&
				!capability.requiredRole &&
				!capability.requiredPermission,
		)
		.map((capability) => capability.name)
		.filter((name) => !isCapabilityAvailableViaApiTool(name))
	expect(missing).toEqual([])
})
