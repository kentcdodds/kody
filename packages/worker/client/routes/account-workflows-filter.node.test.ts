import { expect, test } from 'vitest'
import {
	filterAccountWorkflows,
	isActiveAccountWorkflow,
	readWorkflowsViewFilter,
	type FilterableAccountWorkflow,
} from './account-workflows-filter.ts'

function workflow(
	overrides: Partial<FilterableAccountWorkflow> &
		Pick<FilterableAccountWorkflow, 'id'>,
): FilterableAccountWorkflow {
	return {
		sourceType: 'inline',
		workflowName: overrides.id,
		status: 'queued',
		runAt: '2026-07-28T12:00:00.000Z',
		...overrides,
	}
}

test('account workflows filters cover active/history views and search', () => {
	expect(readWorkflowsViewFilter('/account/workflows')).toBe('active')
	expect(readWorkflowsViewFilter('/account/workflows?view=history')).toBe(
		'history',
	)
	expect(readWorkflowsViewFilter('/account/workflows?view=all')).toBe('all')
	expect(readWorkflowsViewFilter('/account/workflows?view=nope')).toBe('active')

	const workflows = [
		workflow({
			id: 'live-queued',
			workflowName: 'Send digest',
			status: 'queued',
		}),
		workflow({
			id: 'live-running',
			workflowName: 'Package sync',
			sourceType: 'package',
			packageId: 'pkg-1',
			status: 'running',
		}),
		workflow({
			id: 'done-complete',
			workflowName: 'Finished digest',
			status: 'complete',
		}),
		workflow({
			id: 'done-errored',
			workflowName: 'Failed ping',
			status: 'errored',
			lastError: 'boom',
		}),
	]

	expect(isActiveAccountWorkflow(workflows[0]!)).toBe(true)
	expect(isActiveAccountWorkflow(workflows[2]!)).toBe(false)

	expect(
		filterAccountWorkflows(workflows, {
			view: 'active',
			search: '',
		}).map((item) => item.id),
	).toEqual(['live-queued', 'live-running'])

	expect(
		filterAccountWorkflows(workflows, {
			view: 'history',
			search: '',
		}).map((item) => item.id),
	).toEqual(['done-complete', 'done-errored'])

	expect(
		filterAccountWorkflows(workflows, {
			view: 'all',
			search: '',
		}).map((item) => item.id),
	).toEqual(['live-queued', 'live-running', 'done-complete', 'done-errored'])

	expect(
		filterAccountWorkflows(workflows, {
			view: 'history',
			search: 'failed',
		}).map((item) => item.id),
	).toEqual(['done-errored'])

	expect(
		filterAccountWorkflows(workflows, {
			view: 'all',
			search: 'pkg-1',
		}).map((item) => item.id),
	).toEqual(['live-running'])
})
