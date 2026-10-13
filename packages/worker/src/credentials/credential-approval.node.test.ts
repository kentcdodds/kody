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
import { insertEnablement } from '#worker/enablements/repo.ts'
import {
	approveCredentialProposal,
	resolveCredentialApproval,
} from './credential-approval.ts'
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

test('an enable-only proposal turns a minted webhook on at Approve, once', async () => {
	const t = await setup()
	const enableIncoming = parseCredentialApprovalQuery(
		new URL(
			buildCredentialApprovalHref({
				username: 'acme-clients',
				kodyId: 'digest',
				changes: [],
				enable: [{ kind: 'webhook', name: 'incoming' }],
			}),
			'https://kody.test',
		).searchParams,
	)

	const unminted = (
		await resolveCredentialApproval(
			await t.scopeFor('ann', 'member'),
			enableIncoming,
		)
	).view
	expect(unminted.canApprove).toBe(false)
	expect(unminted.enable).toEqual([
		{
			trigger: { kind: 'webhook', name: 'incoming' },
			willEnable: false,
			error: {
				code: 'webhook_not_minted',
				message:
					'Webhook "incoming" has no URL yet. Mint its URL first, then approve it here.',
			},
		},
	])

	// A stored signing secret keeps the enable from minting one.
	await t.db
		.prepare(
			`INSERT INTO webhook_endpoints
				(id, user_id, package_id, webhook_name, url_secret_hash, hmac_secret_encrypted, created_at, rotated_at)
			VALUES ('ep-incoming', ?, ?, 'incoming', 'hash', 'sealed', ?, ?)`,
		)
		.bind(
			t.acmeId,
			t.savedPackage.id,
			'2026-10-13T00:00:00.000Z',
			'2026-10-13T00:00:00.000Z',
		)
		.run()
	expect(await t.enablementCount()).toBe(0)

	const scope = await t.scopeFor('ann', 'member')
	const { view } = await resolveCredentialApproval(scope, enableIncoming)
	expect(view).toMatchObject({
		canApprove: true,
		changes: [],
		enable: [
			{
				trigger: { kind: 'webhook', name: 'incoming' },
				willEnable: true,
				error: null,
			},
		],
	})
	const outcome = await approveCredentialProposal({
		scope,
		proposal: enableIncoming,
		fingerprint: view.fingerprint,
	})
	expect(outcome.status).toBe('approved')
	expect(outcome.view.enable[0]!.willEnable).toBe(false)
	expect(await t.enablementCount()).toBe(1)
	const enabled = await t.db
		.prepare(
			`SELECT instance_id, enabler_user_id, state FROM enablements WHERE trigger_kind = 'webhook'`,
		)
		.first<{ instance_id: string; enabler_user_id: string; state: string }>()
	expect(enabled).toEqual({
		instance_id: 'ep-incoming',
		enabler_user_id: String(t.people.ann.personId),
		state: 'on',
	})

	// Approving again writes nothing; someone else cannot take the webhook over.
	const again = await resolveCredentialApproval(
		await t.scopeFor('ann', 'member'),
		enableIncoming,
	)
	await approveCredentialProposal({
		scope: await t.scopeFor('ann', 'member'),
		proposal: enableIncoming,
		fingerprint: again.view.fingerprint,
	})
	expect(await t.enablementCount()).toBe(1)
	const bea = (
		await resolveCredentialApproval(
			await t.scopeFor('bea', 'owner'),
			enableIncoming,
		)
	).view
	expect(bea.canApprove).toBe(false)
	expect(bea.enable[0]!.error?.code).toBe('webhook_other_enabler')
})

test('a webhook another person turns on between resolve and write is a conflict that writes nothing', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	await t.grantUse(prod, 'ann')
	await t.db
		.prepare(
			`INSERT INTO webhook_endpoints
				(id, user_id, package_id, webhook_name, url_secret_hash, hmac_secret_encrypted, created_at, rotated_at)
			VALUES ('ep-incoming', ?, ?, 'incoming', 'hash', 'sealed', ?, ?)`,
		)
		.bind(
			t.acmeId,
			t.savedPackage.id,
			'2026-10-13T00:00:00.000Z',
			'2026-10-13T00:00:00.000Z',
		)
		.run()
	const incoming = {
		type: 'trigger',
		trigger: { kind: 'webhook', name: 'incoming' },
	} as const
	const proposal = proposalOf([
		{ target: incoming, needKey: 'mail', credentials: [{ id: prod }] },
	])
	const scope = await t.scopeFor('ann', 'member')
	const { view } = await resolveCredentialApproval(scope, proposal)
	expect(view).toMatchObject({
		canApprove: true,
		changes: [{ willEnable: true, error: null }],
	})

	// Bea's enablement lands after Ann's plan was made and before her batch.
	const racingDb = new Proxy(t.db, {
		get(target, property) {
			if (property === 'batch') {
				return async (statements: Array<D1PreparedStatement>) => {
					await insertEnablement({
						db: target,
						enablement: {
							orgId: t.acmeId,
							packageId: t.savedPackage.id,
							triggerKind: 'webhook',
							triggerName: 'incoming',
							instanceId: 'ep-incoming',
							enablerUserId: String(t.people.bea.personId),
							origin: 'enabled',
						},
					})
					return await target.batch(statements)
				}
			}
			const value = Reflect.get(target, property) as unknown
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	const outcome = await approveCredentialProposal({
		scope: { ...scope, env: { ...scope.env, APP_DB: racingDb } },
		proposal,
		fingerprint: view.fingerprint,
	})
	expect(outcome.status).toBe('conflict')
	if (outcome.status !== 'conflict') return
	expect(outcome.message).toContain('another person')
	expect(outcome.view.canApprove).toBe(false)
	expect(outcome.view.changes[0]!.error?.code).toBe('webhook_other_enabler')
	expect(await t.enablementCount()).toBe(1)
	const mappings = await t.db
		.prepare(`SELECT COUNT(*) AS n FROM credential_mappings`)
		.first<{ n: number }>()
	expect(mappings!.n).toBe(0)
	const live = await t.db
		.prepare(`SELECT enabler_user_id FROM enablements`)
		.first<{ enabler_user_id: string }>()
	expect(live!.enabler_user_id).toBe(String(t.people.bea.personId))
})
