import { expect, test } from 'vitest'
import {
	parseUserScopedConnectorRoutePath,
	userScopedConnectorIngressPath,
	userScopedConnectorSessionKey,
} from './connector-session-key.ts'

test('connector session keys and ingress routes round-trip without segment collisions', () => {
	const userA = userScopedConnectorSessionKey({
		userId: 'user-aaa',
		instanceId: 'home',
	})
	const userB = userScopedConnectorSessionKey({
		userId: 'user-bbb',
		instanceId: 'home',
	})
	expect(userA).not.toBe(userB)
	expect(userA).toBe('["user-aaa","home"]')

	const collidingA = userScopedConnectorSessionKey({
		userId: 'user-aaa',
		instanceId: 'a/b',
	})
	const collidingB = userScopedConnectorSessionKey({
		userId: 'user-aaa',
		instanceId: 'a',
	})
	expect(collidingA).not.toBe(collidingB)

	expect(
		userScopedConnectorIngressPath({
			username: 'user-aaa',
			instanceId: 'living-room',
		}),
	).toBe('/@user-aaa/connectors/living-room')
	expect(
		userScopedConnectorIngressPath({
			username: 'with space',
			instanceId: 'a b',
		}),
	).toBe('/@with%20space/connectors/a%20b')

	expect(
		parseUserScopedConnectorRoutePath('/@user-aaa/connectors/home/snapshot'),
	).toEqual({
		username: 'user-aaa',
		instanceId: 'home',
		rest: '/snapshot',
	})
	expect(
		parseUserScopedConnectorRoutePath('/@user-bbb/connectors/abc'),
	).toEqual({
		username: 'user-bbb',
		instanceId: 'abc',
		rest: '',
	})
	expect(parseUserScopedConnectorRoutePath('/connectors/home')).toBeNull()
	expect(parseUserScopedConnectorRoutePath('/@user-aaa/connectors')).toBeNull()
})
