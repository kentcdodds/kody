import { expect, test } from 'vitest'
import {
	checkFrictionLogPolicy,
	checkFrictionLogPolicyContent,
	frictionSkippedLabel,
	retiredHtmlSkipMarker,
} from './check-friction-log-policy.ts'

test('friction-log policy rejects HTML skip marker and requires label gate', () => {
	const bad = [
		'# Friction log',
		'',
		'Include `<!-- friction-log:skipped -->` to skip.',
	].join('\n')
	expect(checkFrictionLogPolicyContent(bad)).toEqual({
		ok: false,
		errors: expect.arrayContaining([
			expect.stringContaining(retiredHtmlSkipMarker),
			expect.stringContaining('HTML comment'),
			expect.stringContaining(frictionSkippedLabel),
		]),
	})

	const good = [
		'# Friction log',
		'',
		'| `friction-skipped` | Daily sweep will not re-investigate until this label is removed. |',
		'',
		'This repository does not define labels in-tree (no `.github/labels.yml`).',
		'',
		'Daily sweep eligibility is: open + `friction` + NOT',
		'`friction-skipped`. Eligibility does not scrape issue comments.',
		'',
		'apply the GitHub label `friction-skipped`. Unskip by removing',
		'`friction-skipped`. When acting, remove `friction-skipped` if present.',
	].join('\n')
	expect(checkFrictionLogPolicyContent(good)).toEqual({
		ok: true,
		errors: [],
	})
})

test('contributing friction-log.md matches label-based skip policy', async () => {
	const result = await checkFrictionLogPolicy()
	expect(result).toEqual({ ok: true, errors: [] })
})
