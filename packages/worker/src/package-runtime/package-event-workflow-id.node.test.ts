import { describe, expect, test } from 'vitest'
import { buildPackageEventWorkflowId } from './package-event-workflow-id.ts'

describe('buildPackageEventWorkflowId', () => {
	test('builds deterministic ids for package event workflows', () => {
		expect(
			buildPackageEventWorkflowId({
				packageId: '1a0476b4-c1d6-47ad-802e-dd5f4631c919',
				workflowName: 'shade-event',
				planDate: '2026-05-01',
				eventKey: 'north-east-open',
			}),
		).toBe(
			'package-event:1a0476b4-c1d6-47ad-802e-dd5f4631c919:shade-event:2026-05-01:north-east-open',
		)
	})

	test('encodes id segments and rejects blank segments', () => {
		expect(
			buildPackageEventWorkflowId({
				packageId: 'package/id',
				workflowName: 'shade event',
				planDate: '2026-05-01',
				eventKey: 'kitchen:door',
			}),
		).toBe('package-event:package%2Fid:shade%20event:2026-05-01:kitchen%3Adoor')
		expect(() =>
			buildPackageEventWorkflowId({
				packageId: 'package-id',
				workflowName: ' ',
				planDate: '2026-05-01',
				eventKey: 'event-key',
			}),
		).toThrow('workflowName must not be empty')
	})
})
