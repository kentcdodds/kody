import { type HomeConnectorConfig } from '../../config.ts'
import { fetchAccessNetworksUnleashed } from './http.ts'
import {
	type AccessNetworksUnleashedClient,
	type AccessNetworksUnleashedPersistedController,
	type AccessNetworksUnleashedRecord,
} from './types.ts'

type SessionState = {
	baseUrl: string | null
	loginUrl: string | null
	csrfToken: string | null
	cookie: string | null
}

const xmlEntityMap: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
}

function decodeXmlEntities(value: string) {
	return value.replace(
		/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi,
		(match, entity) => {
			const normalized = String(entity).toLowerCase()
			if (normalized.startsWith('#x')) {
				return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16))
			}
			if (normalized.startsWith('#')) {
				return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10))
			}
			return xmlEntityMap[normalized] ?? match
		},
	)
}

function normalizeFieldName(value: string) {
	return value
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/[^a-zA-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toLowerCase()
}

function parseScalar(value: string): string | number | boolean | null {
	const trimmed = decodeXmlEntities(value.trim())
	if (!trimmed) return null
	if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)
	if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed)
	if (/^(true|enabled|yes)$/i.test(trimmed)) return true
	if (/^(false|disabled|no)$/i.test(trimmed)) return false
	return trimmed
}

function parseAttributes(value: string): AccessNetworksUnleashedRecord {
	const record: AccessNetworksUnleashedRecord = {}
	const attributeRegex = /([:\w-]+)\s*=\s*(["'])(.*?)\2/gs
	for (const match of value.matchAll(attributeRegex)) {
		const key = normalizeFieldName(match[1] ?? '')
		if (!key) continue
		record[key] = parseScalar(match[3] ?? '')
	}
	return record
}

function parseElements(xml: string, tagName: string) {
	const records: Array<AccessNetworksUnleashedRecord> = []
	const elementRegex = new RegExp(
		`<${tagName}(?=[\\s>/])(?<attributes>[^>]*)>(?<body>[\\s\\S]*?)<\\/${tagName}>|<${tagName}(?=[\\s>/])(?<selfClosingAttributes>[^>]*)\\/>`,
		'gi',
	)
	for (const match of xml.matchAll(elementRegex)) {
		const groups = match.groups ?? {}
		const attributes =
			groups['attributes'] ?? groups['selfClosingAttributes'] ?? ''
		const body = groups['body'] ?? ''
		const record = parseAttributes(
			attributes,
		) as AccessNetworksUnleashedRecord & {
			rawXml?: string
		}
		record.rawXml = match[0]
		const childRegex = /<([:\w-]+)(?=[\s>/])[^>]*>([\s\S]*?)<\/\1>/g
		for (const childMatch of body.matchAll(childRegex)) {
			const key = normalizeFieldName(childMatch[1] ?? '')
			if (!key || key in record) continue
			const childBody = childMatch[2] ?? ''
			if (/<[a-zA-Z]/.test(childBody)) continue
			record[key] = parseScalar(childBody)
		}
		records.push(record)
	}
	return records
}

function pickFirstRecords(xml: string, tagNames: Array<string>) {
	for (const tagName of tagNames) {
		const records = parseElements(xml, tagName)
		if (records.length > 0) return records
	}
	return []
}

function extractElementByAttribute(input: {
	xml: string
	tagName: string
	attributeName: string
	attributeValue: string
}) {
	const elementRegex = new RegExp(
		`<${input.tagName}(?=[\\s>/])(?<attributes>[^>]*)>(?<body>[\\s\\S]*?)<\\/${input.tagName}>|<${input.tagName}(?=[\\s>/])(?<selfClosingAttributes>[^>]*)\\/>`,
		'gi',
	)
	for (const match of input.xml.matchAll(elementRegex)) {
		const attributes =
			match.groups?.['attributes'] ??
			match.groups?.['selfClosingAttributes'] ??
			''
		const record = parseAttributes(attributes)
		if (String(record[input.attributeName] ?? '') === input.attributeValue) {
			return match[0]
		}
	}
	return null
}

function escapeXmlAttribute(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
}

function normalizeHost(host: string) {
	const trimmed = host.trim()
	if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '')
	return `https://${trimmed.replace(/\/+$/, '')}`
}

export function normalizeAccessNetworksUnleashedMacAddress(value: string) {
	const cleaned = value
		.trim()
		.toLowerCase()
		.replace(/[^0-9a-f]/g, '')
	if (cleaned.length !== 12) {
		throw new Error('macAddress must be a valid 12-hex-digit MAC address.')
	}
	const octets = cleaned.match(/.{2}/g)
	if (!octets) {
		throw new Error('macAddress must be a valid MAC address.')
	}
	return octets.join(':')
}

function collectCookies(headers: Headers, existing: string | null) {
	const cookies = new Map<string, string>()
	if (existing) {
		for (const cookie of existing.split(';')) {
			const [name, ...rest] = cookie.trim().split('=')
			if (name && rest.length > 0) cookies.set(name, rest.join('='))
		}
	}
	const setCookie =
		typeof headers.getSetCookie === 'function'
			? headers.getSetCookie()
			: headers.get('set-cookie')
				? [headers.get('set-cookie') ?? '']
				: []
	for (const cookieHeader of setCookie) {
		const [cookie] = cookieHeader.split(';')
		const [name, ...rest] = cookie.trim().split('=')
		if (name && rest.length > 0) cookies.set(name, rest.join('='))
	}
	return [...cookies.entries()]
		.map(([name, value]) => `${name}=${value}`)
		.join('; ')
}

function extractCsrfToken(text: string) {
	const match =
		/HTTP_X_CSRF_TOKEN["']?\s*[:=]\s*["']([^"']+)["']/i.exec(text) ??
		/X-CSRF-Token["']?\s*[:=]\s*["']([^"']+)["']/i.exec(text) ??
		/([a-zA-Z0-9]{10,})/.exec(text)
	return match?.[1] ?? null
}

async function fetchWithTimeout(input: {
	url: string
	init?: RequestInit
	timeoutMs: number
	allowInsecureTls: boolean
}) {
	return await fetchAccessNetworksUnleashed({
		url: input.url,
		init: input.init,
		timeoutMs: input.timeoutMs,
		allowInsecureTls: input.allowInsecureTls,
	})
}

export function createAccessNetworksUnleashedAjaxClient(input: {
	config: HomeConnectorConfig
	controller: AccessNetworksUnleashedPersistedController
}) {
	const { config } = input
	const state: SessionState = {
		baseUrl: null,
		loginUrl: null,
		csrfToken: null,
		cookie: null,
	}
	let loginPromise: Promise<void> | null = null

	function requireConfig() {
		const host = input.controller.host.trim()
		const username = input.controller.username
		const password = input.controller.password
		if (
			!host ||
			username == null ||
			password == null ||
			username.length === 0 ||
			password.length === 0
		) {
			throw new Error(
				'Access Networks Unleashed requires an adopted controller with stored credentials. Run access_networks_unleashed_scan_controllers, access_networks_unleashed_adopt_controller, then access_networks_unleashed_set_credentials.',
			)
		}
		return {
			host: normalizeHost(host),
			username,
			password,
		}
	}

	async function request(
		url: string,
		init: RequestInit = {},
		timeoutMs = config.accessNetworksUnleashedRequestTimeoutMs,
	) {
		const headers = new Headers(init.headers)
		if (state.cookie) headers.set('Cookie', state.cookie)
		if (state.csrfToken) headers.set('X-CSRF-Token', state.csrfToken)
		const response = await fetchWithTimeout({
			url,
			timeoutMs,
			allowInsecureTls: config.accessNetworksUnleashedAllowInsecureTls,
			init: {
				...init,
				headers,
				redirect: 'manual',
			} as RequestInit,
		})
		state.cookie = collectCookies(response.headers, state.cookie)
		return response
	}

	async function login() {
		const credentials = requireConfig()
		let csrfToken: string | null = null
		const head = await request(credentials.host, { method: 'GET' }, 3_000)
		const location = head.headers.get('location')
		if (!location) {
			throw new Error(
				'Access Networks Unleashed login did not return an admin redirect.',
			)
		}
		const loginUrl = new URL(location, head.url || credentials.host).toString()
		const baseUrl = new URL('.', loginUrl).toString().replace(/\/$/, '')
		const login = await request(loginUrl, {
			method: 'GET',
			headers: {
				Accept: '*/*',
			},
		})
		const loginWithParams = new URL(login.url || loginUrl)
		loginWithParams.searchParams.set('username', credentials.username)
		loginWithParams.searchParams.set('password', credentials.password)
		loginWithParams.searchParams.set('ok', 'Log In')
		const loginResult = await request(loginWithParams.toString(), {
			method: 'GET',
		})
		if (loginResult.status === 200) {
			throw new Error('Access Networks Unleashed login was rejected.')
		}
		const csrfHeader =
			loginResult.headers.get('HTTP_X_CSRF_TOKEN') ??
			loginResult.headers.get('x-csrf-token')
		if (csrfHeader) {
			csrfToken = csrfHeader
		} else {
			const tokenResponse = await request(`${baseUrl}/_csrfTokenVar.jsp`, {
				method: 'GET',
			})
			if (tokenResponse.ok) {
				csrfToken = extractCsrfToken(await tokenResponse.text())
			}
		}
		state.loginUrl = loginUrl
		state.baseUrl = baseUrl
		state.csrfToken = csrfToken
	}

	async function ensureSession() {
		if (state.baseUrl) return
		loginPromise ??= login().finally(() => {
			loginPromise = null
		})
		await loginPromise
	}

	function resetSession() {
		state.baseUrl = null
		state.loginUrl = null
		state.csrfToken = null
		state.cookie = null
	}

	async function postXml(
		path: string,
		xml: string,
		timeoutMs?: number,
		allowRedirectRetry = false,
		redirectCount = 0,
	) {
		await ensureSession()
		if (!state.baseUrl)
			throw new Error('Access Networks Unleashed session has no base URL.')
		const response = await request(
			`${state.baseUrl}/${path.replace(/^\/+/, '')}`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'text/xml',
					Accept: 'text/xml, */*',
				},
				body: xml,
			},
			timeoutMs,
		)
		if (response.status === 302) {
			resetSession()
			if (!allowRedirectRetry) {
				throw new Error(
					'Access Networks Unleashed redirected during a command. The session was reset; retry after confirming the command did not already apply.',
				)
			}
			if (redirectCount >= 1) {
				throw new Error(
					'Access Networks Unleashed redirected after reauthentication.',
				)
			}
			await ensureSession()
			return await postXml(
				path,
				xml,
				timeoutMs,
				allowRedirectRetry,
				redirectCount + 1,
			)
		}
		const text = await response.text()
		if (!response.ok) {
			throw new Error(
				`Access Networks Unleashed request failed with HTTP ${response.status}: ${text.trim()}`,
			)
		}
		if (!text.trim()) {
			throw new Error('Access Networks Unleashed returned an empty response.')
		}
		if (
			/<xmsg\b[^>]*\b(?:error|status)=["'](?:1|true|error|failed)["']/i.test(
				text,
			)
		) {
			throw new Error(`Access Networks Unleashed rejected the command: ${text}`)
		}
		return text
	}

	async function cmdstat(xml: string, tagNames: Array<string>) {
		const response = await postXml('_cmdstat.jsp', xml, undefined, true)
		return pickFirstRecords(response, tagNames)
	}

	async function getConf(component: string, tagNames: Array<string>) {
		const response = await postXml(
			'_conf.jsp',
			`<ajax-request action='getconf' DECRYPT_X='true' updater='${escapeXmlAttribute(component)}.0.5' comp='${escapeXmlAttribute(component)}'/>`,
			undefined,
			true,
		)
		return pickFirstRecords(response, tagNames)
	}

	async function findWlan(name: string) {
		const wlans = await getConf('wlansvc-list', ['wlansvc'])
		return wlans.find((wlan) => String(wlan['name'] ?? '') === name) ?? null
	}

	async function findAp(macAddress: string) {
		const normalized = macAddress.toLowerCase()
		const aps = await getConf('ap-list', ['ap'])
		return (
			aps.find(
				(ap) =>
					String(ap['mac'] ?? ap['mac_address'] ?? '').toLowerCase() ===
					normalized,
			) ?? null
		)
	}

	const client: AccessNetworksUnleashedClient = {
		async getSystemInfo() {
			const records = await cmdstat(
				"<ajax-request action='getstat' comp='system'><identity/><sysinfo/><unleashed-network/></ajax-request>",
				['system', 'identity', 'sysinfo', 'unleashed-network'],
			)
			return records[0] ?? {}
		},
		async listClients() {
			return await cmdstat(
				"<ajax-request action='getstat' comp='stamgr' enable-gzip='0'><client LEVEL='1' /></ajax-request>",
				['client'],
			)
		},
		async listAccessPoints() {
			const stats = await cmdstat(
				"<ajax-request action='getstat' comp='stamgr' enable-gzip='0'><ap LEVEL='1' /></ajax-request>",
				['ap'],
			)
			return stats.length > 0 ? stats : await getConf('ap-list', ['ap'])
		},
		async listWlans() {
			return await getConf('wlansvc-list', ['wlansvc'])
		},
		async listEvents(limit = 50) {
			const records = await cmdstat(
				"<ajax-request action='getstat' comp='eventd'><xevent /></ajax-request>",
				['xevent', 'event'],
			)
			return records.slice(0, Math.max(1, Math.min(300, Math.trunc(limit))))
		},
		async blockClient(macAddress) {
			const mac = escapeXmlAttribute(macAddress.toLowerCase())
			await postXml(
				'_cmdstat.jsp',
				`<ajax-request action='docmd' xcmd='block' checkAbility='10' comp='stamgr'><xcmd check-ability='10' tag='client' acl-id='1' client='${mac}' cmd='block'><client client='${mac}' acl-id='1' hostname=''></client></xcmd></ajax-request>`,
			)
		},
		async unblockClient(macAddress) {
			const mac = macAddress.toLowerCase()
			const aclResponse = await postXml(
				'_conf.jsp',
				"<ajax-request action='getconf' DECRYPT_X='true' updater='acl-list.0.5' comp='acl-list'/>",
				undefined,
				true,
			)
			const rawXml = extractElementByAttribute({
				xml: aclResponse,
				tagName: 'acl',
				attributeName: 'id',
				attributeValue: '1',
			})
			if (!rawXml) {
				throw new Error('Access Networks Unleashed system ACL was not found.')
			}
			const updatedAclXml = rawXml.replace(
				/<deny\b[^>]*\bmac\s*=\s*(["'])(?<mac>.*?)\1[^>]*\/?>/gi,
				(match, _quote, deniedMac: string) =>
					deniedMac.toLowerCase() === mac ? '' : match,
			)
			await postXml(
				'_conf.jsp',
				`<ajax-request action='updobj' comp='acl-list' updater='blocked-clients'>${updatedAclXml}</ajax-request>`,
			)
		},
		async setWlanEnabled(name, enabled) {
			const wlan = await findWlan(name)
			if (!wlan)
				throw new Error(
					`Access Networks Unleashed WLAN "${name}" was not found.`,
				)
			await postXml(
				'_conf.jsp',
				`<ajax-request action='updobj' updater='wlansvc-list.${Date.now()}' comp='wlansvc-list'><wlansvc id='${escapeXmlAttribute(String(wlan['id'] ?? ''))}' name='${escapeXmlAttribute(String(wlan['name'] ?? name))}' enable-type='${enabled ? 0 : 1}' IS_PARTIAL='true'/></ajax-request>`,
			)
		},
		async restartAccessPoint(macAddress) {
			const mac = escapeXmlAttribute(macAddress.toLowerCase())
			await postXml(
				'_cmdstat.jsp',
				`<ajax-request action='docmd' xcmd='reset' checkAbility='2' updater='stamgr.${Date.now()}' comp='stamgr'><xcmd cmd='reset' ap='${mac}' tag='ap' checkAbility='2'/></ajax-request>`,
			)
		},
		async setAccessPointLeds(macAddress, enabled) {
			const ap = await findAp(macAddress)
			if (!ap) {
				throw new Error(
					`Access Networks Unleashed access point "${macAddress}" was not found.`,
				)
			}
			await postXml(
				'_conf.jsp',
				`<ajax-request action='updobj' updater='ap-list.${Date.now()}' comp='ap-list'><ap id='${escapeXmlAttribute(String(ap['id'] ?? ''))}' IS_PARTIAL='true' led-off='${enabled ? 'false' : 'true'}' /></ajax-request>`,
			)
		},
	}

	return client
}
