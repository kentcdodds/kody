import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	grantMatchesConsentOrg,
	orgGrantFields,
	readOrgIdFromGrantMetadata,
	readOrgIdFromGrantMetadataOrUserId,
	readOrgIdFromGrantProps,
	readOrgIdFromGrantPropsOrUserId,
	stampOrgIdOnTokenExchange,
} from './oauth-grant.ts'

test('orgGrantFields stamps the same orgId on props and metadata', () => {
	expect(orgGrantFields('org-1')).toEqual({
		props: { orgId: ownerIdFromStored('org-1') },
		metadata: { orgId: ownerIdFromStored('org-1') },
	})
})

test('readOrgId helpers ignore missing or blank values', () => {
	expect(readOrgIdFromGrantProps({ orgId: ' org-1 ' as OwnerId })).toBe('org-1')
	expect(
		readOrgIdFromGrantMetadata({ orgId: ownerIdFromStored('org-1') }),
	).toBe('org-1')
	expect(readOrgIdFromGrantProps({})).toBeNull()
	expect(readOrgIdFromGrantProps(null)).toBeNull()
	expect(readOrgIdFromGrantProps({ orgId: '  ' as OwnerId })).toBeNull()
	expect(
		readOrgIdFromGrantPropsOrUserId({ userId: ownerIdFromStored('user-1') }),
	).toBe('user-1')
	expect(
		readOrgIdFromGrantPropsOrUserId({
			orgId: ownerIdFromStored('org-1'),
			userId: ownerIdFromStored('user-1'),
		}),
	).toBe('org-1')
})

test('grantMatchesConsentOrg uses metadata.orgId then userId fallback', () => {
	expect(
		grantMatchesConsentOrg({
			metadata: { orgId: ownerIdFromStored('org-acme') },
			userId: ownerIdFromStored('user-1'),
			orgId: ownerIdFromStored('org-acme'),
		}),
	).toBe(true)
	expect(
		grantMatchesConsentOrg({
			metadata: { orgId: ownerIdFromStored('org-acme') },
			userId: ownerIdFromStored('user-1'),
			orgId: ownerIdFromStored('org-ada'),
		}),
	).toBe(false)
	expect(
		grantMatchesConsentOrg({
			metadata: {},
			userId: ownerIdFromStored('user-1'),
			orgId: ownerIdFromStored('user-1'),
		}),
	).toBe(true)
	expect(
		grantMatchesConsentOrg({
			metadata: {},
			userId: ownerIdFromStored('user-1'),
			orgId: ownerIdFromStored('org-acme'),
		}),
	).toBe(false)
	expect(
		readOrgIdFromGrantMetadataOrUserId({
			metadata: null,
			userId: ownerIdFromStored('user-1'),
		}),
	).toBe('user-1')
})

test('stampOrgIdOnTokenExchange backfills orgId from userId and no-ops when set', () => {
	expect(
		stampOrgIdOnTokenExchange({
			props: { userId: ownerIdFromStored('user-1'), email: 'ada@example.com' },
			grantType: 'refresh_token',
		}),
	).toEqual({
		newProps: {
			userId: ownerIdFromStored('user-1'),
			email: 'ada@example.com',
			orgId: ownerIdFromStored('user-1'),
		},
	})
	expect(
		stampOrgIdOnTokenExchange({
			props: {
				userId: ownerIdFromStored('user-1'),
				orgId: ownerIdFromStored('org-1'),
			},
			grantType: 'authorization_code',
		}),
	).toBeUndefined()
	expect(
		stampOrgIdOnTokenExchange({
			props: {
				userId: ownerIdFromStored('user-1'),
				orgId: ownerIdFromStored('user-1'),
			},
			grantType: 'refresh_token',
		}),
	).toBeUndefined()
	expect(
		stampOrgIdOnTokenExchange({ props: {}, grantType: 'refresh_token' }),
	).toBeUndefined()
	expect(stampOrgIdOnTokenExchange({ props: null })).toBeUndefined()
})
