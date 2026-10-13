import { expect, test, vi } from 'vitest'
import {
	dailyTarget as daily,
	mineTarget as mine,
	orgDefaultTarget as orgDefault,
	setupPackageCredentialMappingFixture,
} from '#worker/test-support/package-credential-mapping-fixture.ts'
import {
	buildCredentialApprovalHref,
	parseCredentialApprovalQuery,
	type CredentialMappingProposalChange,
} from '#universal/credential-contracts.ts'
import {
	approveCredentialProposal,
	resolveCredentialApproval,
} from './credential-approval.ts'
import { buildWriteCredentialMappingStatement } from './credential-mappings.ts'
import { buildPackageCredentialsView } from './package-credential-mappings.ts'

const mocks = vi.hoisted(() => ({ loadPackageManifestBySourceId: vi.fn() }))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

const setup = () =>
	setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})

/** Round-trips through the link codec, as the approval page reads it. */
function proposalOf(
	changes: Array<CredentialMappingProposalChange>,
	reason?: string,
) {
	const href = buildCredentialApprovalHref({
		username: 'acme-clients',
		kodyId: 'digest',
		changes,
		reason,
	})
	return parseCredentialApprovalQuery(
		new URL(href, 'https://kody.test').searchParams,
	)
}

test('one Approve writes default and trigger mappings and turns the trigger on', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	const slack = await t.storeKey('team-slack', 'slack')
	const proposal = proposalOf(
		[
			{
				target: orgDefault,
				needKey: 'mail',
				credentials: [{ name: 'resend-prod', scope: 'org' }],
			},
			{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
		],
		'Daily digest posts to Slack',
	)
	const scope = await t.scopeFor('bea', 'owner')
	const { view } = await resolveCredentialApproval(scope, proposal)
	expect(view).toMatchObject({
		ok: true,
		package: { id: t.savedPackage.id, kodyId: 'digest' },
		reason: 'Daily digest posts to Slack',
		canApprove: true,
		errors: [],
	})
	expect(
		view.changes.map((change) => [
			change.needKey,
			change.before,
			change.after.map((ref) => ref.id),
			change.willEnable,
			change.error,
		]),
	).toEqual([
		['mail', null, [prod], false, null],
		['chat', null, [slack], true, null],
	])
	expect(view.fingerprint).toMatch(/^[0-9a-f]{64}$/)
	expect(
		(await resolveCredentialApproval(scope, proposal)).view.fingerprint,
	).toBe(view.fingerprint)
	expect(await t.enablementCount()).toBe(0)

	const outcome = await approveCredentialProposal({
		scope,
		proposal,
		fingerprint: view.fingerprint,
	})
	expect(outcome.status).toBe('approved')
	expect(outcome.view.changes.map((change) => change.before)).toEqual([
		[expect.objectContaining({ id: prod })],
		[expect.objectContaining({ id: slack })],
	])
	expect(outcome.view.changes[1]!.willEnable).toBe(false)
	expect(await t.enablementCount()).toBe(1)
	const packageView = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	expect(packageView.needs[0]!.effective).toMatchObject({
		source: 'org',
		status: 'ready',
	})
	expect(packageView.triggers[0]).toMatchObject({
		enablement: { state: 'on', enabledByYou: true },
		mappings: [
			{ needKey: 'mail', effective: { source: 'org' } },
			{ needKey: 'chat', effective: { source: 'trigger', status: 'ready' } },
		],
	})
})

test('Approve refuses a proposal with errors and one that changed since review', async () => {
	const t = await setup()
	await t.storeKey('resend-prod', 'resend')
	const scope = await t.scopeFor('bea', 'owner')

	const broken = proposalOf([
		{ target: mine, needKey: 'nope', credentials: [{ name: 'resend-prod' }] },
	])
	const brokenView = (await resolveCredentialApproval(scope, broken)).view
	expect(brokenView.canApprove).toBe(false)
	expect(brokenView.changes[0]!.error?.code).toBe('need_unknown')
	const invalid = await approveCredentialProposal({
		scope,
		proposal: broken,
		fingerprint: brokenView.fingerprint,
	})
	expect(invalid.status).toBe('invalid')

	const badQuery = parseCredentialApprovalQuery(
		new URLSearchParams('mine[mail]=org:'),
	)
	const badQueryView = (await resolveCredentialApproval(scope, badQuery)).view
	expect(badQueryView.canApprove).toBe(false)
	expect(badQueryView.errors).not.toEqual([])

	const empty = (
		await resolveCredentialApproval(
			scope,
			parseCredentialApprovalQuery(new URLSearchParams()),
		)
	).view
	expect(empty.canApprove).toBe(false)

	const proposal = proposalOf([
		{ target: mine, needKey: 'mail', credentials: [{ name: 'resend-prod' }] },
	])
	const reviewed = (await resolveCredentialApproval(scope, proposal)).view
	expect(reviewed.canApprove).toBe(true)
	// The mapping changes after review, so the reviewed "before" is wrong.
	await t.apply('bea', 'owner', [
		{ target: mine, needKey: 'mail', credentials: [] },
	])
	const stale = await approveCredentialProposal({
		scope: await t.scopeFor('bea', 'owner'),
		proposal,
		fingerprint: reviewed.fingerprint,
	})
	expect(stale.status).toBe('stale')
	expect(stale.view.changes[0]!.before).toEqual([])
	const view = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	expect(view.needs[0]!.defaults.mine?.credentials).toEqual([])

	const fresh = await approveCredentialProposal({
		scope: await t.scopeFor('bea', 'owner'),
		proposal,
		fingerprint: stale.view.fingerprint,
	})
	expect(fresh.status).toBe('approved')
})

test('a replaced credential with the same name changes the fingerprint', async () => {
	const t = await setup()
	await t.storeKey('resend-prod', 'resend')
	const proposal = proposalOf([
		{ target: mine, needKey: 'mail', credentials: [{ name: 'resend-prod' }] },
	])
	const before = (
		await resolveCredentialApproval(await t.scopeFor('bea', 'owner'), proposal)
	).view
	await t.db
		.prepare(`UPDATE secret_entries SET id = ? WHERE name = 'resend-prod'`)
		.bind(crypto.randomUUID())
		.run()
	const after = (
		await resolveCredentialApproval(await t.scopeFor('bea', 'owner'), proposal)
	).view
	expect(after.canApprove).toBe(true)
	expect(after.fingerprint).not.toBe(before.fingerprint)
})

test('an edit between the final check and the write fails Approve and writes nothing', async () => {
	const t = await setup()
	await t.storeKey('resend-prod', 'resend')
	const proposal = proposalOf([
		{ target: mine, needKey: 'mail', credentials: [{ name: 'resend-prod' }] },
	])
	const scope = await t.scopeFor('bea', 'owner')
	const reviewed = (await resolveCredentialApproval(scope, proposal)).view
	// `scope` still holds the rows read before this edit, as a racing
	// request would leave them.
	await t.apply('bea', 'owner', [
		{ target: mine, needKey: 'mail', credentials: [] },
	])
	const outcome = await approveCredentialProposal({
		scope,
		proposal,
		fingerprint: reviewed.fingerprint,
	})
	expect(outcome.status).toBe('stale')
	const view = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	expect(view.needs[0]!.defaults.mine?.credentials).toEqual([])
	expect(await t.mappingAudits()).toHaveLength(1)
})

test('a trigger turned on and mapped after review fails Approve as stale and keeps that mapping', async () => {
	const t = await setup()
	await t.storeKey('team-slack', 'slack')
	await t.storeKey('backup-slack', 'slack')
	const proposal = proposalOf([
		{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
	])
	const scope = await t.scopeFor('bea', 'owner')
	const reviewed = (await resolveCredentialApproval(scope, proposal)).view
	expect(reviewed.changes[0]!.willEnable).toBe(true)
	// Another tab turns the trigger on with a different pick; `scope` still
	// holds the rows read before it.
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'backup-slack' }] },
	])
	const outcome = await approveCredentialProposal({
		scope,
		proposal,
		fingerprint: reviewed.fingerprint,
	})
	expect(outcome.status).toBe('stale')
	const view = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	expect(view.triggers[0]!.mappings[1]).toMatchObject({
		needKey: 'chat',
		effective: {
			source: 'trigger',
			credentials: [expect.objectContaining({ name: 'backup-slack' })],
		},
	})
})

test('switching a stored mapping between unusable credentials changes the fingerprint', async () => {
	const t = await setup()
	const gone1 = await t.storeKey('resend-old-1', 'resend')
	const gone2 = await t.storeKey('resend-old-2', 'resend')
	await t.storeKey('resend-prod', 'resend')
	await t.db
		.prepare(`UPDATE secret_entries SET deleted_at = ? WHERE id IN (?, ?)`)
		.bind(new Date().toISOString(), gone1, gone2)
		.run()
	const storeMine = (id: string) =>
		buildWriteCredentialMappingStatement({
			db: t.db,
			orgId: t.acmeId,
			packageId: t.savedPackage.id,
			needKey: 'mail',
			target: { target: 'mine', personId: t.people.bea.personId },
			credentialIds: [id],
			updatedByUserId: t.people.bea.personId,
			now: new Date().toISOString(),
		}).run()
	const proposal = proposalOf([
		{ target: mine, needKey: 'mail', credentials: [{ name: 'resend-prod' }] },
	])
	const fingerprint = async () =>
		(
			await resolveCredentialApproval(
				await t.scopeFor('bea', 'owner'),
				proposal,
			)
		).view.fingerprint
	await storeMine(gone1)
	const first = await fingerprint()
	await storeMine(gone2)
	expect(await fingerprint()).not.toBe(first)
})

test('renaming a credential picked by id changes the fingerprint', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	const proposal = proposalOf([
		{ target: mine, needKey: 'mail', credentials: [{ id: prod }] },
	])
	const fingerprint = async () =>
		(
			await resolveCredentialApproval(
				await t.scopeFor('bea', 'owner'),
				proposal,
			)
		).view.fingerprint
	const before = await fingerprint()
	await t.db
		.prepare(`UPDATE secret_entries SET name = 'resend-renamed' WHERE id = ?`)
		.bind(prod)
		.run()
	expect(await fingerprint()).not.toBe(before)
})

test('a member cannot approve org defaults but can approve their own', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	await t.grantUse(prod, 'ann')
	const scope = await t.scopeFor('ann', 'member')
	const orgView = (
		await resolveCredentialApproval(
			scope,
			proposalOf([
				{
					target: orgDefault,
					needKey: 'mail',
					credentials: [{ name: 'resend-prod' }],
				},
			]),
		)
	).view
	expect(orgView.canApprove).toBe(false)
	expect(orgView.changes[0]!.error?.code).toBe('not_allowed')
	const mineView = (
		await resolveCredentialApproval(
			scope,
			proposalOf([
				{ target: mine, needKey: 'mail', credentials: [{ id: prod }] },
			]),
		)
	).view
	expect(mineView.canApprove).toBe(true)
})
