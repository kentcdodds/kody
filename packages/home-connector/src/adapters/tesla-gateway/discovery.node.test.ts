import { expect, test } from 'vitest'
import { __testing } from './discovery.ts'

const {
	decideLeaderStatus,
	expandSlash24,
	isTeslaCert,
	probeLooksLikeTesla,
	ouiFromMac,
	validateJsonGateway,
	TESLA_LEADER_OUIS,
	TESLA_POWERWALL_OUIS,
} = __testing

test('expandSlash24 expands a /24 to 254 host IPs', () => {
	const ips = expandSlash24('192.168.4.0/24')
	expect(ips).toHaveLength(254)
	expect(ips[0]).toBe('192.168.4.1')
	expect(ips.at(-1)).toBe('192.168.4.254')
})

test('expandSlash24 accepts /32 single hosts', () => {
	expect(expandSlash24('10.0.0.5/32')).toEqual(['10.0.0.5'])
})

test('expandSlash24 returns no IPs for invalid CIDRs', () => {
	expect(expandSlash24('not-a-cidr')).toEqual([])
})

test('isTeslaCert recognises Tesla Energy Products O/OU/SAN markers', () => {
	expect(
		isTeslaCert({
			subjectCommonName: 'GTW-1234',
			subjectOrganization: 'Tesla',
			subjectOrganizationalUnit: 'Tesla Energy Products',
			issuerCommonName: 'Tesla Manufacturing CA',
			issuerOrganization: 'Tesla',
			subjectAltName: 'DNS:teg, DNS:powerwall',
			fingerprint256: null,
		}),
	).toBe(true)
	expect(
		isTeslaCert({
			subjectCommonName: 'random.example.com',
			subjectOrganization: 'Other',
			subjectOrganizationalUnit: 'Other',
			issuerCommonName: 'Other',
			issuerOrganization: 'Other',
			subjectAltName: 'DNS:random.example.com',
			fingerprint256: null,
		}),
	).toBe(false)
	expect(isTeslaCert(null)).toBe(false)
})

test('probeLooksLikeTesla treats 401 + Bad Credentials body as Tesla', () => {
	expect(
		probeLooksLikeTesla({
			status: 401,
			bodyPreview: '{"error":"Bad Credentials"}',
		}),
	).toBe(true)
	expect(
		probeLooksLikeTesla({
			status: 401,
			bodyPreview: '',
		}),
	).toBe(true)
	expect(
		probeLooksLikeTesla({
			status: 200,
			bodyPreview: 'ok',
		}),
	).toBe(false)
	expect(
		probeLooksLikeTesla({
			status: 401,
			bodyPreview: 'something completely unrelated',
		}),
	).toBe(false)
})

test('ouiFromMac extracts the manufacturer OUI', () => {
	expect(ouiFromMac('90:03:71:11:22:33')).toBe('90:03:71')
	expect(ouiFromMac('00:d6:cb:aa:bb:cc')).toBe('00:d6:cb')
	expect(ouiFromMac(null)).toBeNull()
	expect(ouiFromMac('not-a-mac')).toBeNull()
})

test('Tesla OUI sets recognise leader and powerwall MACs', () => {
	expect(TESLA_LEADER_OUIS.has('90:03:71')).toBe(true)
	expect(TESLA_POWERWALL_OUIS.has('00:d6:cb')).toBe(true)
})

test('decideLeaderStatus uses OUI as the authoritative leader signal', () => {
	// Powerwall OUI -> never a leader, even though the cert SAN looks identical.
	expect(
		decideLeaderStatus({
			certIsTesla: true,
			macAddress: '00:d6:cb:11:22:33',
			ouiIsLeader: false,
			ouiIsPowerwall: true,
		}),
	).toBe(false)
	// BGW2 leader OUI -> leader.
	expect(
		decideLeaderStatus({
			certIsTesla: true,
			macAddress: '90:03:71:11:22:33',
			ouiIsLeader: true,
			ouiIsPowerwall: false,
		}),
	).toBe(true)
	// Cert is Tesla but ARP miss left us with no MAC -> candidate leader.
	// We accept this so a real BGW2 hidden behind ARP issues still surfaces.
	expect(
		decideLeaderStatus({
			certIsTesla: true,
			macAddress: null,
			ouiIsLeader: false,
			ouiIsPowerwall: false,
		}),
	).toBe(true)
	// Cert is NOT Tesla and no MAC -> not a leader.
	expect(
		decideLeaderStatus({
			certIsTesla: false,
			macAddress: null,
			ouiIsLeader: false,
			ouiIsPowerwall: false,
		}),
	).toBe(false)
	// Has a MAC but it's an unknown OUI -> not a leader (cert SAN alone is
	// insufficient when we have an OUI signal that doesn't match Tesla).
	expect(
		decideLeaderStatus({
			certIsTesla: true,
			macAddress: 'aa:bb:cc:11:22:33',
			ouiIsLeader: false,
			ouiIsPowerwall: false,
		}),
	).toBe(false)
})

test('validateJsonGateway rejects malformed discovery feed entries', () => {
	expect(
		validateJsonGateway({
			gatewayId: 'tesla-gateway-home-1',
			host: '192.168.1.10',
			port: 443,
			role: 'leader',
			lastSeenAt: '2026-05-01T00:00:00.000Z',
		}),
	).toMatchObject({
		gatewayId: 'tesla-gateway-home-1',
		host: '192.168.1.10',
		port: 443,
		role: 'leader',
	})
	expect(
		validateJsonGateway({ gatewayId: 'missing-host', port: 443 }),
	).toBeNull()
	expect(
		validateJsonGateway({
			gatewayId: 'bad-port',
			host: '192.168.1.10',
			port: '443',
		}),
	).toBeNull()
})
