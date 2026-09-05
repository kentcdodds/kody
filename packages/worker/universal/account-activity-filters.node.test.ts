import { expect, test } from 'vitest'
import {
	accountActivitySummaryWindowMs,
	activityEmptyLabel,
	buildActivitySearch,
	readAccountActivityFilters,
	statusFilterToRunStatus,
	surfaceFilterToRunSurface,
} from './account-activity-filters.ts'

test('activity URL defaults stay on open errors and recent runs flip to all history', () => {
	expect(accountActivitySummaryWindowMs).toBe(7 * 24 * 60 * 60 * 1000)
	expect(
		readAccountActivityFilters('https://example.com/account/activity'),
	).toEqual({
		viewFilter: 'errors',
		statusFilter: 'error',
		surfaceFilter: 'all',
		triageFilter: 'open',
		cursor: null,
	})
	expect(
		readAccountActivityFilters(
			'https://example.com/account/activity?status=all&surface=job&cursor=abc&error_triage=ignored',
		),
	).toEqual({
		viewFilter: 'errors',
		statusFilter: 'all',
		surfaceFilter: 'job',
		triageFilter: 'ignored',
		cursor: 'abc',
	})
	expect(
		readAccountActivityFilters(
			'https://example.com/account/activity?view=recent',
		),
	).toEqual({
		viewFilter: 'recent',
		statusFilter: 'all',
		surfaceFilter: 'all',
		triageFilter: 'all',
		cursor: null,
	})
	expect(
		readAccountActivityFilters(
			'https://example.com/account/activity?view=recent&status=success&surface=webhook',
		),
	).toEqual({
		viewFilter: 'recent',
		statusFilter: 'success',
		surfaceFilter: 'webhook',
		triageFilter: 'all',
		cursor: null,
	})
	expect(
		readAccountActivityFilters(
			'https://example.com/account/activity?view=nope&status=success',
		),
	).toEqual({
		viewFilter: 'errors',
		statusFilter: 'success',
		surfaceFilter: 'all',
		triageFilter: 'open',
		cursor: null,
	})

	expect(statusFilterToRunStatus('error')).toBe('error')
	expect(statusFilterToRunStatus('success')).toBe('success')
	expect(statusFilterToRunStatus('running')).toBe('running')
	expect(statusFilterToRunStatus('all')).toBeNull()
	expect(surfaceFilterToRunSurface('all')).toBeNull()
	expect(surfaceFilterToRunSurface('webhook')).toBe('webhook')

	expect(
		buildActivitySearch({
			view: 'errors',
			status: 'error',
			surface: 'all',
			triage: 'open',
		}),
	).toBe('')
	expect(
		buildActivitySearch({
			view: 'recent',
			status: 'all',
			surface: 'all',
			triage: 'all',
		}),
	).toBe('?view=recent')
	expect(
		buildActivitySearch({
			view: 'recent',
			status: 'success',
			surface: 'job',
			triage: 'open',
		}),
	).toBe('?view=recent&status=success&surface=job&error_triage=open')

	expect(
		activityEmptyLabel({
			view: 'errors',
			status: 'error',
			surface: 'all',
			triage: 'open',
			summaryTotal: 0,
		}),
	).toMatch(/No failures in the last 7 days/)
	expect(
		activityEmptyLabel({
			view: 'errors',
			status: 'error',
			surface: 'all',
			triage: 'open',
			summaryTotal: 4,
		}),
	).toMatch(/Switch to Recent runs/)
	expect(
		activityEmptyLabel({
			view: 'recent',
			status: 'all',
			surface: 'all',
			triage: 'all',
			summaryTotal: 0,
		}),
	).toBe('Nothing ran in the last 7 days.')
	expect(
		activityEmptyLabel({
			view: 'recent',
			status: 'success',
			surface: 'all',
			triage: 'all',
			summaryTotal: 3,
		}),
	).toBe('No runs match the current filters.')
})
