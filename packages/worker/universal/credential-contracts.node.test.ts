import { expect, test } from 'vitest'
import {
	type CredentialApprovalChangeView,
	type CredentialApprovalErrorCode,
	type CredentialInjectView,
	type CredentialListItem,
	type CredentialTriggerRef,
	type EffectiveCredentialMapping,
	type EffectiveCredentialMappingStatus,
	type PackageCredentialNeedView,
	type PackageCredentialsIncomplete,
	type PackageCredentialsWriteError,
	type PackageCredentialsWriteFailure,
	type PackageTriggerView,
	type StoredCredentialMapping,
	type CredentialApprovalView,
	type CredentialKind,
	type CredentialKindMode,
	type CredentialListFilters,
	type CredentialListItemStatus,
	type CredentialListResponse,
	type CredentialMappingChange,
	type CredentialMappingProposalChange,
	type CredentialMappingLayer,
	type CredentialMappingSource,
	type CredentialRef,
	type CredentialScope,
	type CredentialTriggerKind,
	type PackageCredentialsView,
	buildCredentialApprovalHref,
	credentialApprovalErrorCodes,
	credentialCreatePath,
	credentialKinds,
	credentialMappingLayers,
	credentialScopes,
	credentialTriggerKinds,
	describeCredentialMappingTarget,
	fetchCapableCredentialKinds,
	isCredentialKind,
	buildCredentialCreateHref,
	buildCredentialCreateUrl,
	maxCredentialProposalValues,
	orgCredentialCreatePath,
	parseCredentialApprovalQuery,
	parseCredentialCreateQuery,
	parseCredentialPick,
} from './credential-contracts.ts'

test('creation links lock the kind only when required and round-trip prefill', () => {
	const href = buildCredentialCreateHref({
		kind: 'oauth',
		kindMode: 'required',
		name: 'github',
		provider: 'github',
		description: 'Read PRs',
		allowedHosts: ['api.github.com', ' uploads.github.com '],
		packageKodyId: 'pr-digest',
		needKey: 'github',
		extra: { scopes: 'repo', kind: 'secret' },
	})
	const url = new URL(href, 'https://kody.codes')
	expect(url.pathname).toBe('/connect/credential')
	const parsed = parseCredentialCreateQuery(url.searchParams)
	expect(parsed).toMatchObject({
		kind: 'oauth',
		kindLocked: true,
		name: 'github',
		provider: 'github',
		description: 'Read PRs',
		allowedHosts: ['api.github.com', 'uploads.github.com'],
		packageKodyId: 'pr-digest',
		needKey: 'github',
	})
	expect(parsed.passthrough.toString()).toBe('scopes=repo')

	const hint = parseCredentialCreateQuery(
		new URL(buildCredentialCreateHref({ kind: 'secret' }), 'https://x.test')
			.searchParams,
	)
	expect(hint).toMatchObject({ kind: 'secret', kindLocked: false })

	const unknownKind = parseCredentialCreateQuery(
		new URLSearchParams('kind=nope&kindMode=required'),
	)
	expect(unknownKind).toMatchObject({ kind: null, kindLocked: false })
	expect(buildCredentialCreateHref({})).toBe('/connect/credential')
	expect(
		buildCredentialCreateUrl('https://kody.codes/mcp', { name: 'x' }),
	).toBe('https://kody.codes/connect/credential?name=x')
})

test('links that know their org open that org, and carry package scope, expiry, and locks', () => {
	expect(orgCredentialCreatePath('acme clients')).toBe(
		'/@acme%20clients/-/credentials/new',
	)
	expect(buildCredentialCreateHref({ orgSlug: 'acme', name: 'x' })).toBe(
		'/@acme/-/credentials/new?name=x',
	)
	expect(buildCredentialCreateHref({ orgSlug: ' ', name: 'x' })).toBe(
		'/connect/credential?name=x',
	)

	const packageKey = new URL(
		buildCredentialCreateHref({
			orgSlug: 'acme',
			kind: 'secret',
			name: 'TOKEN',
			packageScopedTo: 'pkg-1',
			expiresAt: '2026-12-31',
			allowedPackages: ['pkg-2'],
		}),
		'https://kody.codes',
	)
	expect(Object.fromEntries(packageKey.searchParams)).toEqual({
		kind: 'secret',
		name: 'TOKEN',
		scope: 'package',
		packageId: 'pkg-1',
		expiresAt: '2026-12-31',
	})
	expect(parseCredentialCreateQuery(packageKey.searchParams)).toMatchObject({
		packageScopedTo: 'pkg-1',
		packageScopeMissingId: false,
		expiresAt: '2026-12-31',
		allowedPackages: [],
	})

	const locked = parseCredentialCreateQuery(
		new URL(
			buildCredentialCreateHref({
				allowedPackages: ['pkg-2', ' pkg-1 ', 'pkg-2'],
			}),
			'https://kody.codes',
		).searchParams,
	)
	expect(locked).toMatchObject({
		packageScopedTo: null,
		allowedPackages: ['pkg-2', 'pkg-1'],
	})
	expect(locked.passthrough.toString()).toBe('')

	const parse = (search: string) =>
		parseCredentialCreateQuery(new URLSearchParams(search))
	expect(parse('packageId=pkg-1')).toMatchObject({
		packageScopedTo: 'pkg-1',
	})
	expect(parse('scope=package')).toMatchObject({
		packageScopedTo: null,
		packageScopeMissingId: true,
	})
	expect(parse('scope=user&packageId=pkg-1&allowedPackages=a,b')).toMatchObject(
		{ packageScopedTo: null, allowedPackages: ['a', 'b'] },
	)
})

test('picks parse names, scoped names, and ids', () => {
	expect(parseCredentialPick('work')).toEqual({ name: 'work' })
	expect(parseCredentialPick('org:work')).toEqual({
		name: 'work',
		scope: 'org',
	})
	expect(parseCredentialPick('personal:me')).toEqual({
		name: 'me',
		scope: 'personal',
	})
	expect(parseCredentialPick('id:abc')).toEqual({ id: 'abc' })
	expect(parseCredentialPick('acme:bot')).toEqual({ name: 'acme:bot' })
	expect(parseCredentialPick('name:org:bot')).toEqual({ name: 'org:bot' })
	expect(parseCredentialPick('  ')).toBeNull()
	expect(parseCredentialPick('org:')).toBeNull()
	expect(parseCredentialPick('name:')).toBeNull()
})

test('names that look like prefixes and brackets in names round-trip', () => {
	const changes = [
		{
			target: { type: 'default', layer: 'mine' },
			needKey: 'google',
			credentials: [
				{ name: 'org:bot' },
				{ name: 'id:abc' },
				{ name: 'name:x' },
			],
		},
		{
			target: {
				type: 'trigger',
				trigger: { kind: 'cron', name: 'daily]backup [50%]' },
			},
			needKey: 'git[hub]',
			credentials: [{ id: 'cred-1' }],
		},
	] satisfies Array<CredentialMappingProposalChange>
	const href = buildCredentialApprovalHref({
		username: 'acme',
		kodyId: 'pr-digest',
		changes,
	})
	const url = new URL(href, 'https://kody.codes')
	expect(url.searchParams.getAll('mine[google]')).toEqual([
		'name:org:bot',
		'name:id:abc',
		'name:name:x',
	])
	expect(parseCredentialApprovalQuery(url.searchParams)).toEqual({
		changes,
		enable: [],
		reason: null,
		errors: [],
	})
})

test('a leading space before a reserved prefix still escapes the name', () => {
	const href = buildCredentialApprovalHref({
		username: 'acme',
		kodyId: 'pr-digest',
		changes: [
			{
				target: { type: 'default', layer: 'mine' },
				needKey: 'google',
				credentials: [{ name: ' org:bot' }, { name: '  id:abc' }],
			},
		],
	})
	const url = new URL(href, 'https://kody.codes')
	expect(url.searchParams.getAll('mine[google]')).toEqual([
		'name: org:bot',
		'name:  id:abc',
	])
	expect(parseCredentialApprovalQuery(url.searchParams).changes).toEqual([
		{
			target: { type: 'default', layer: 'mine' },
			needKey: 'google',
			credentials: [{ name: 'org:bot' }, { name: 'id:abc' }],
		},
	])
})

test('approval links round-trip defaults, personal defaults, triggers, and none', () => {
	const href = buildCredentialApprovalHref({
		username: 'acme',
		kodyId: 'pr-digest',
		changes: [
			{
				target: { type: 'default', layer: 'org' },
				needKey: 'github',
				credentials: [{ name: 'acme-bot', scope: 'org' }],
			},
			{
				target: { type: 'default', layer: 'mine' },
				needKey: 'google',
				credentials: [{ name: 'work' }, { id: 'cred-2' }],
			},
			{
				target: {
					type: 'trigger',
					trigger: { kind: 'cron', name: 'daily' },
				},
				needKey: 'slack',
				credentials: [],
			},
		],
		reason: 'Daily digest',
	})
	const url = new URL(href, 'https://kody.codes')
	expect(url.pathname).toBe('/@acme/pr-digest/approve-credentials')
	expect(parseCredentialApprovalQuery(url.searchParams)).toEqual({
		changes: [
			{
				target: { type: 'default', layer: 'org' },
				needKey: 'github',
				credentials: [{ name: 'acme-bot', scope: 'org' }],
			},
			{
				target: { type: 'default', layer: 'mine' },
				needKey: 'google',
				credentials: [{ name: 'work' }, { id: 'cred-2' }],
			},
			{
				target: {
					type: 'trigger',
					trigger: { kind: 'cron', name: 'daily' },
				},
				needKey: 'slack',
				credentials: [],
			},
		],
		enable: [],
		reason: 'Daily digest',
		errors: [],
	})
})

test('enable params turn triggers on with no mapping, deduped and capped with mappings', () => {
	const href = buildCredentialApprovalHref({
		username: 'acme',
		kodyId: 'pr-digest',
		changes: [],
		enable: [
			{ kind: 'webhook', name: 'incoming' },
			{ kind: 'subscription', name: 'acme.thing:happened' },
		],
	})
	expect(href).toBe(
		'/@acme/pr-digest/approve-credentials?enable=webhook%3Aincoming&enable=subscription%3Aacme.thing%3Ahappened',
	)
	expect(
		parseCredentialApprovalQuery(
			new URL(href, 'https://kody.codes').searchParams,
		),
	).toEqual({
		changes: [],
		enable: [
			{ kind: 'webhook', name: 'incoming' },
			{ kind: 'subscription', name: 'acme.thing:happened' },
		],
		reason: null,
		errors: [],
	})

	const messy = parseCredentialApprovalQuery(
		new URLSearchParams(
			'enable=webhook:incoming&enable= webhook : incoming &enable=hourly:x&enable=cron:&enable=daily',
		),
	)
	expect(messy.enable).toEqual([{ kind: 'webhook', name: 'incoming' }])
	expect(messy.errors).toEqual([
		'"enable=hourly:x" is not a trigger; use <cron|subscription|webhook>:<name>.',
		'"enable=cron:" is not a trigger; use <cron|subscription|webhook>:<name>.',
		'"enable=daily" is not a trigger; use <cron|subscription|webhook>:<name>.',
	])

	const tooMany = new URLSearchParams()
	for (let index = 0; index < maxCredentialProposalValues; index += 1) {
		tooMany.append(`default[need-${index}]`, 'x')
	}
	tooMany.append('enable', 'webhook:incoming')
	const capped = parseCredentialApprovalQuery(tooMany)
	expect(capped).toMatchObject({ changes: [], enable: [] })
	expect(capped.errors).toHaveLength(1)
})

test('approval queries report malformed mapping params and cap the size', () => {
	const parsed = parseCredentialApprovalQuery(
		new URLSearchParams(
			'defaults[github]=x&trigger[hourly:x][github]=y&utm_source=chat&default[github]=org:bot',
		),
	)
	expect(parsed.errors).toEqual([
		'"defaults[github]" is not a mapping parameter.',
		'"trigger[hourly:x][github]" is not a mapping parameter.',
	])
	expect(parsed.changes).toEqual([
		{
			target: { type: 'default', layer: 'org' },
			needKey: 'github',
			credentials: [{ name: 'bot', scope: 'org' }],
		},
	])

	const invalid = parseCredentialApprovalQuery(
		new URLSearchParams(
			'default[github]=org:&mine[google]=&mine[google]=work&default[slack]=',
		),
	)
	expect(invalid.errors).toEqual([
		'"default[github]" has a value that is not a credential pick: "org:".',
		'"mine[google]" mixes an empty value (none on purpose) with credentials.',
	])
	expect(invalid.changes).toEqual([
		{
			target: { type: 'default', layer: 'org' },
			needKey: 'slack',
			credentials: [],
		},
	])

	const tooMany = new URLSearchParams()
	for (let index = 0; index <= maxCredentialProposalValues; index += 1) {
		tooMany.append(`default[need-${index}]`, 'x')
	}
	const capped = parseCredentialApprovalQuery(tooMany)
	expect(capped.changes).toEqual([])
	expect(capped.errors).toHaveLength(1)

	// The cap counts mapping params; a repeatable param may list many values.
	const manyValues = new URLSearchParams()
	for (let index = 0; index <= maxCredentialProposalValues; index += 1) {
		manyValues.append('default[github]', `bot-${index}`)
	}
	const repeated = parseCredentialApprovalQuery(manyValues)
	expect(repeated.errors).toEqual([])
	expect(repeated.changes[0]!.credentials).toHaveLength(
		maxCredentialProposalValues + 1,
	)
})

test('param names that decode to one target and need make one change', () => {
	const parsed = parseCredentialApprovalQuery(
		new URLSearchParams(
			'default[github]=org:bot&default[git%68ub]=personal:me&default[ github ]=extra&trigger[cron:daily][slack]=a&trigger[cron: daily][slack]=b',
		),
	)
	expect(parsed.errors).toEqual([])
	expect(parsed.changes).toEqual([
		{
			target: { type: 'default', layer: 'org' },
			needKey: 'github',
			credentials: [
				{ name: 'bot', scope: 'org' },
				{ name: 'me', scope: 'personal' },
				{ name: 'extra' },
			],
		},
		{
			target: { type: 'trigger', trigger: { kind: 'cron', name: 'daily' } },
			needKey: 'slack',
			credentials: [{ name: 'a' }, { name: 'b' }],
		},
	])
})

test('a blank pick name never encodes as none on purpose', () => {
	const href = buildCredentialApprovalHref({
		username: 'acme',
		kodyId: 'digest',
		changes: [
			{
				target: { type: 'default', layer: 'mine' },
				needKey: 'mail',
				credentials: [{ name: '  ' }],
			},
		],
	})
	const parsed = parseCredentialApprovalQuery(
		new URL(href, 'https://kody.codes').searchParams,
	)
	expect(parsed.changes).toEqual([])
	expect(parsed.errors).toEqual([
		'"mine[mail]" has a value that is not a credential pick: "name:  ".',
	])
})

test('vocabularies match the contract', () => {
	expect(credentialKinds).toEqual([
		'secret',
		'oauth',
		'mcp',
		'url',
		'login',
		'signing',
	] satisfies Array<CredentialKind>)
	expect(fetchCapableCredentialKinds).toEqual(['secret', 'oauth', 'login'])
	expect(isCredentialKind('mcp')).toBe(true)
	expect(isCredentialKind('vault')).toBe(false)
	expect(credentialScopes).toEqual([
		'org',
		'personal',
	] satisfies Array<CredentialScope>)
	expect(credentialMappingLayers).toEqual([
		'org',
		'mine',
	] satisfies Array<CredentialMappingLayer>)
	expect(credentialTriggerKinds).toEqual([
		'cron',
		'subscription',
		'webhook',
	] satisfies Array<CredentialTriggerKind>)
	expect(credentialApprovalErrorCodes).toContain(
		'webhook_other_enabler' satisfies CredentialApprovalErrorCode,
	)
	expect(credentialCreatePath).toBe('/connect/credential')
	expect(
		describeCredentialMappingTarget({ type: 'default', layer: 'org' }),
	).toBe('org default')
	expect(
		describeCredentialMappingTarget({
			type: 'trigger',
			trigger: { kind: 'webhook', name: 'push' },
		}),
	).toBe('webhook "push"')
})

const acmeBot: CredentialRef = {
	id: 'cred-1',
	name: 'acme-bot',
	scope: 'org',
	kind: 'oauth',
}

/** Sample payloads in the contract's shapes, for UI fixtures. */
const samplePackageCredentials = {
	ok: true,
	package: { id: 'pkg-1', kodyId: 'pr-digest', canManage: true },
	needs: [
		{
			key: 'github',
			kind: null,
			provider: 'github',
			description: 'Read PRs to summarize them',
			multiple: false,
			defaults: {
				org: {
					credentials: [acmeBot],
					unusableIds: [],
					updatedAt: '2026-10-13T00:00:00.000Z',
					updatedBy: { username: 'kent' },
				},
				mine: null,
			},
			effective: {
				source: 'org' satisfies CredentialMappingSource,
				status: 'ready',
				credentials: [acmeBot],
				candidates: [],
				createUrl: null,
			},
			options: [acmeBot],
			createUrl:
				'https://kody.codes/connect/credential?provider=github&name=github',
		},
	],
	triggers: [
		{
			trigger: { kind: 'cron', name: 'daily' },
			instanceId: 'job-1',
			enablement: { id: 'en-1', state: 'on', enabledByYou: true },
			canEdit: true,
			mappings: [
				{
					needKey: 'github',
					override: null,
					effective: {
						source: 'org',
						status: 'ready',
						credentials: [acmeBot],
						candidates: [],
						createUrl: null,
					},
				},
			],
		},
	],
	locked: [
		{
			id: 'cred-3',
			kind: 'mcp',
			name: 'linear',
			scope: 'org',
			provider: 'linear',
			description: '',
			hosts: ['mcp.linear.app'],
			inject: null,
			packageId: null,
			lockedToPackageIds: ['pkg-1'],
			expiresAt: null,
			createdAt: '2026-10-13T00:00:00.000Z',
			updatedAt: '2026-10-13T00:00:00.000Z',
			status: 'ok' satisfies CredentialListItemStatus,
			statusMessage: null,
			mcp: { url: 'https://mcp.linear.app/mcp', enabled: true },
		},
	],
	incomplete: [],
} satisfies PackageCredentialsView

const sampleApproval = {
	ok: true,
	package: { id: 'pkg-1', kodyId: 'pr-digest' },
	reason: 'Daily digest',
	canApprove: true,
	fingerprint: 'abc',
	changes: [
		{
			target: { type: 'default', layer: 'org' },
			needKey: 'github',
			need: {
				kind: null,
				provider: 'github',
				description: 'Read PRs to summarize them',
				multiple: false,
			},
			before: null,
			beforeUnusableIds: [],
			after: [acmeBot],
			willEnable: false,
			error: null,
		},
	],
	enable: [
		{
			trigger: { kind: 'webhook', name: 'incoming' },
			willEnable: true,
			error: null,
		},
	],
	errors: [],
} satisfies CredentialApprovalView

test('sample payloads line up with the proposal codecs', () => {
	const change = sampleApproval.changes[0]!
	const proposal: CredentialMappingChange = {
		target: change.target,
		needKey: change.needKey,
		credentials: change.after.map((ref) => ({
			name: ref.name,
			scope: ref.scope,
		})),
	}
	const href = buildCredentialApprovalHref({
		username: 'acme',
		kodyId: samplePackageCredentials.package.kodyId,
		changes: [{ ...proposal, credentials: proposal.credentials ?? [] }],
	})
	expect(href).toBe(
		'/@acme/pr-digest/approve-credentials?default%5Bgithub%5D=org%3Aacme-bot',
	)
	const list: CredentialListResponse = {
		ok: true,
		credentials: samplePackageCredentials.locked,
	}
	const filters: CredentialListFilters = { kinds: ['mcp'], locked: 'pkg-1' }
	expect(
		list.credentials.filter((item) => filters.kinds?.includes(item.kind)),
	).toHaveLength(1)
	const mode: CredentialKindMode = 'required'
	expect(buildCredentialCreateHref({ kind: 'mcp', kindMode: mode })).toBe(
		'/connect/credential?kind=mcp&kindMode=required',
	)
})

test('each view part is addressable on its own', () => {
	const need: PackageCredentialNeedView = samplePackageCredentials.needs[0]!
	const stored: StoredCredentialMapping | null = need.defaults.org
	const effective: EffectiveCredentialMapping = need.effective
	const status: EffectiveCredentialMappingStatus = effective.status
	const trigger: PackageTriggerView = samplePackageCredentials.triggers[0]!
	const triggerRef: CredentialTriggerRef = trigger.trigger
	const locked: CredentialListItem = samplePackageCredentials.locked[0]!
	const inject: CredentialInjectView = {
		kind: 'header',
		name: 'Authorization',
		format: 'Bearer {value}',
	}
	const incomplete: PackageCredentialsIncomplete = {
		needKey: 'slack',
		where: { type: 'trigger', trigger: triggerRef },
		status: 'unbound',
	}
	const change: CredentialApprovalChangeView = sampleApproval.changes[0]!
	const writeError: PackageCredentialsWriteError = {
		needKey: 'github',
		target: change.target,
		code: 'need_unknown',
		message: 'No such need.',
	}
	const failure: PackageCredentialsWriteFailure = {
		ok: false,
		errors: [writeError],
	}
	expect(failure.errors[0]?.code).toBe('need_unknown')
	expect([
		stored?.credentials[0]?.name,
		status,
		triggerRef.name,
		locked.kind,
		inject.kind,
		incomplete.status,
		change.needKey,
	]).toEqual([
		'acme-bot',
		'ready',
		'daily',
		'mcp',
		'header',
		'unbound',
		'github',
	])
})
