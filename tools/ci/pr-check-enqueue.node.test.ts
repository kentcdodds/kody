import { readFileSync } from 'node:fs'

import { expect, test } from 'vitest'

import {
	decidePrCheckEnqueue,
	enqueueTriggerEvent,
	openPullRequestFromPayload,
	resolvePrCheckEnqueue,
	selectOpenPullRequest,
	type OpenPullRequest,
} from './pr-check-enqueue.ts'

function pull(
	overrides: Partial<OpenPullRequest> & Pick<OpenPullRequest, 'number'>,
): OpenPullRequest {
	return {
		draft: false,
		fork: false,
		baseRef: 'main',
		mergeable: false,
		baseSha: 'base',
		headSha: 'head',
		title: 'title',
		url: 'https://github.com/kentcdodds/kody/pull/1',
		...overrides,
	}
}

test('enqueue only for push and ready-for-review target events', () => {
	expect(enqueueTriggerEvent('push')).toBe(true)
	expect(enqueueTriggerEvent('pull_request_target')).toBe(true)
	expect(enqueueTriggerEvent('pull_request')).toBe(false)
	expect(enqueueTriggerEvent('workflow_dispatch')).toBe(false)
})

test('selects a ready same-repo PR over drafts and forks', () => {
	expect(
		selectOpenPullRequest([
			pull({ number: 9, draft: true }),
			pull({ number: 4, fork: true, mergeable: true }),
			pull({ number: 7, mergeable: false }),
			pull({ number: 3, baseRef: 'other' }),
		])?.number,
	).toBe(7)
	expect(selectOpenPullRequest([pull({ number: 2, draft: true })])?.draft).toBe(
		true,
	)
	expect(
		selectOpenPullRequest([pull({ number: 1, baseRef: 'dev' })]),
	).toBeNull()
})

test('skips mergeable PRs and enqueues conflicted or unknown heads', () => {
	expect(decidePrCheckEnqueue(null, true)).toEqual({
		action: 'skip',
		reason: 'no-pr',
	})
	expect(decidePrCheckEnqueue(pull({ number: 1, fork: true }), true)).toEqual({
		action: 'skip',
		reason: 'fork',
	})
	expect(decidePrCheckEnqueue(pull({ number: 1, draft: true }), true)).toEqual({
		action: 'skip',
		reason: 'draft',
	})
	expect(
		decidePrCheckEnqueue(pull({ number: 1, mergeable: true }), false),
	).toEqual({ action: 'skip', reason: 'mergeable' })
	expect(
		decidePrCheckEnqueue(pull({ number: 1, mergeable: false }), false),
	).toMatchObject({ action: 'enqueue', reason: 'conflict' })
	expect(
		decidePrCheckEnqueue(pull({ number: 1, mergeable: null }), false),
	).toEqual({ action: 'wait' })
	expect(
		decidePrCheckEnqueue(pull({ number: 1, mergeable: null }), true),
	).toMatchObject({ action: 'enqueue', reason: 'mergeable-unknown' })
	expect(
		decidePrCheckEnqueue(pull({ number: 1, mergeable: false }), true, 'closed'),
	).toMatchObject({ action: 'cleanup', reason: 'closed' })
	expect(
		decidePrCheckEnqueue(pull({ number: 1, mergeable: true }), true, 'closed'),
	).toEqual({ action: 'skip', reason: 'mergeable' })
	expect(
		decidePrCheckEnqueue(pull({ number: 1, fork: true }), true, 'closed'),
	).toEqual({ action: 'skip', reason: 'fork' })
	expect(
		decidePrCheckEnqueue(pull({ number: 1, draft: true }), true, 'closed'),
	).toEqual({ action: 'skip', reason: 'draft' })
})

test('parses a pull payload and refuses a missing head repo', () => {
	expect(
		openPullRequestFromPayload({
			number: 12,
			draft: false,
			mergeable: false,
			title: 'Fix',
			html_url: 'https://example.test/12',
			base: { ref: 'main', sha: 'abc' },
			head: { sha: 'def', repo: { fork: false } },
		}),
	).toMatchObject({ number: 12, fork: false, mergeable: false, headSha: 'def' })
	expect(
		openPullRequestFromPayload({
			number: 12,
			base: { ref: 'main', sha: 'abc' },
			head: { sha: 'def', repo: null },
		})?.fork,
	).toBe(true)
	expect(openPullRequestFromPayload({ number: '12' })).toBeNull()
})

test('polls until mergeable is known, then skips a clean PR', async () => {
	const responses = [{ mergeable: null }, { mergeable: true }]
	const sleeps: Array<number> = []
	const decision = await resolvePrCheckEnqueue({
		eventName: 'push',
		branch: 'feature',
		repository: 'kentcdodds/kody',
		eventPullNumber: null,
		github: {
			sleep: async (ms) => {
				sleeps.push(ms)
			},
			getJson: async (path) => {
				if (path.includes('/pulls?')) {
					return [
						{
							number: 8,
							draft: false,
							mergeable: null,
							title: 'Feature',
							html_url: 'https://example.test/8',
							base: { ref: 'main', sha: 'base' },
							head: { sha: 'head', repo: { fork: false } },
						},
					]
				}
				const next = responses.shift()
				return {
					number: 8,
					draft: false,
					mergeable: next?.mergeable ?? null,
					title: 'Feature',
					html_url: 'https://example.test/8',
					base: { ref: 'main', sha: 'base' },
					head: { sha: 'head', repo: { fork: false } },
				}
			},
		},
	})
	expect(decision).toEqual({ action: 'skip', reason: 'mergeable' })
	expect(sleeps.length).toBeGreaterThan(0)
})

test('conflict enqueue workflows call Validate and Preview without workflow_dispatch', () => {
	const validate = readFileSync('.github/workflows/validate.yml', 'utf8')
	const preview = readFileSync('.github/workflows/preview.yml', 'utf8')
	const enqueueValidate = readFileSync(
		'.github/workflows/enqueue-validate.yml',
		'utf8',
	)
	const enqueuePreview = readFileSync(
		'.github/workflows/enqueue-preview.yml',
		'utf8',
	)
	const decideAction = readFileSync(
		'.github/actions/decide-pr-check-enqueue/action.yml',
		'utf8',
	)
	expect(validate).toContain('workflow_call:')
	expect(validate).toContain('inputs.base_sha')
	expect(validate).toContain(
		'github.event.pull_request.number || inputs.pr_number || github.ref',
	)
	expect(preview).toContain(
		"github.event_name == 'push' && inputs.pr_number != ''",
	)
	expect(preview).toContain('pull_request_target')
	expect(preview).toContain("inputs.action == 'cleanup'")
	for (const source of [enqueueValidate, enqueuePreview]) {
		expect(source).toContain('pull_request_target:')
		expect(source).toContain('opened')
		expect(source).toContain('reopened')
		expect(source).toContain('branches-ignore:')
		expect(source).toContain('./.github/actions/decide-pr-check-enqueue')
		expect(source).not.toContain('workflow_dispatch')
		expect(source).toContain('head.repo.fork == false')
		expect(source).toContain('github.event.pull_request.number || github.ref')
	}
	expect(enqueuePreview).toContain('closed')
	expect(enqueueValidate).not.toContain('closed')
	expect(enqueueValidate).toContain('checks: write')
	expect(enqueueValidate).toContain('./.github/workflows/validate.yml')
	expect(enqueuePreview).toContain('./.github/workflows/preview.yml')
	expect(enqueuePreview).toContain('secrets: inherit')
	expect(enqueuePreview).toContain('deployments: write')
	expect(enqueuePreview).toContain('checks: write')
	expect(decideAction).toContain('tools/ci/pr-check-enqueue.ts')
})
