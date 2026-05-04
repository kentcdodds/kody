import { type HomeConnectorConfig } from '../../config.ts'
import { fetchAccessNetworksUnleashed } from './http.ts'
import {
	type AccessNetworksUnleashedAddWlanGroupInput,
	type AccessNetworksUnleashedAddWlanInput,
	type AccessNetworksUnleashedClient,
	type AccessNetworksUnleashedEditWlanInput,
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

	async function getConfRaw(component: string) {
		return await postXml(
			'_conf.jsp',
			`<ajax-request action='getconf' DECRYPT_X='true' updater='${escapeXmlAttribute(component)}.0.5' comp='${escapeXmlAttribute(component)}'/>`,
			undefined,
			true,
		)
	}

	async function getWlanRawXml(name: string) {
		const xml = await getConfRaw('wlansvc-list')
		return extractElementByAttribute({
			xml,
			tagName: 'wlansvc',
			attributeName: 'name',
			attributeValue: name,
		})
	}

	async function getDefaultWlanTemplateXml() {
		const xml = await getConfRaw('wlansvc-standard-template')
		const elementRegex = /<wlansvc(?=[\s>/])[^>]*>[\s\S]*?<\/wlansvc>|<wlansvc(?=[\s>/])[^>]*\/>/i
		const match = elementRegex.exec(xml)
		if (!match) {
			throw new Error(
				'Access Networks Unleashed default WLAN template was not returned by the controller.',
			)
		}
		return match[0]
	}

	function setOrAddAttribute(elementXml: string, name: string, value: string) {
		const escapedValue = escapeXmlAttribute(value)
		const attrPattern = new RegExp(
			`(\\s${name}\\s*=\\s*)(["'])(.*?)\\2`,
			'i',
		)
		if (attrPattern.test(elementXml)) {
			return elementXml.replace(attrPattern, `$1'${escapedValue}'`)
		}
		return elementXml.replace(/^<(\w[\w-]*)/i, `<$1 ${name}='${escapedValue}'`)
	}

	function removeRootIdAttribute(elementXml: string) {
		const openTagMatch = /^<(\w[\w-]*)([^>]*)>/i.exec(elementXml)
		if (!openTagMatch) return elementXml
		const tagName = openTagMatch[1] ?? ''
		let attributes = openTagMatch[2] ?? ''
		attributes = attributes.replace(/\s+id\s*=\s*(["'])(.*?)\1/i, '')
		return `<${tagName}${attributes}>${elementXml.slice(openTagMatch[0].length)}`
	}

	function getAttributeValue(elementXml: string, name: string): string | null {
		const attrPattern = new RegExp(
			`\\s${name}\\s*=\\s*(["'])(.*?)\\1`,
			'i',
		)
		const match = attrPattern.exec(elementXml)
		return match ? decodeXmlEntities(match[2] ?? '') : null
	}

	function applyWlanPatch(
		elementXml: string,
		patch: {
			name?: string
			ssid?: string
			description?: string
			passphrase?: string
			saePassphrase?: string
			enableType?: 0 | 1
		},
	) {
		let updated = elementXml
		if (patch.name !== undefined) {
			updated = setOrAddAttribute(updated, 'name', patch.name)
		}
		if (patch.ssid !== undefined) {
			updated = setOrAddAttribute(updated, 'ssid', patch.ssid)
		}
		if (patch.description !== undefined) {
			updated = setOrAddAttribute(updated, 'description', patch.description)
		}
		if (patch.enableType !== undefined) {
			updated = setOrAddAttribute(
				updated,
				'enable-type',
				String(patch.enableType),
			)
		}
		if (patch.passphrase !== undefined || patch.saePassphrase !== undefined) {
			const wpaRegex = /<wpa(?=[\s>/])([^>]*)(\/?>)/i
			const wpaMatch = wpaRegex.exec(updated)
			if (wpaMatch) {
				let wpaTag = wpaMatch[0]
				if (patch.passphrase !== undefined) {
					wpaTag = setOrAddAttribute(wpaTag, 'passphrase', patch.passphrase)
				}
				if (patch.saePassphrase !== undefined) {
					wpaTag = setOrAddAttribute(
						wpaTag,
						'sae-passphrase',
						patch.saePassphrase,
					)
				}
				updated = updated.replace(wpaRegex, wpaTag)
			} else {
				const wpaAttrs: Array<string> = ["cipher='aes'", "dynamic-psk='disabled'"]
				if (patch.passphrase !== undefined) {
					wpaAttrs.push(
						`passphrase='${escapeXmlAttribute(patch.passphrase)}'`,
					)
				}
				if (patch.saePassphrase !== undefined) {
					wpaAttrs.push(
						`sae-passphrase='${escapeXmlAttribute(patch.saePassphrase)}'`,
					)
				}
				const wpaTag = `<wpa ${wpaAttrs.join(' ')}/>`
				if (/\/>$/.test(updated)) {
					updated = updated.replace(/\/>$/, `>${wpaTag}</wlansvc>`)
				} else {
					updated = updated.replace(
						/<\/wlansvc>$/,
						`${wpaTag}</wlansvc>`,
					)
				}
			}
		}
		return updated
	}

	async function piecewiseCmdstat(input: {
		comp: string
		elementXml: string
		updater: string
		tagNames: Array<string>
		limit: number
	}) {
		const ts = Date.now()
		const rand = Math.random().toString(36).slice(2, 10)
		const requestId = `${input.updater}.${ts}`
		const cleanupId = `${input.updater}.${ts}.${rand}`
		const xml = `<ajax-request action='getstat' comp='${escapeXmlAttribute(input.comp)}' updater='${escapeXmlAttribute(`${input.updater}.${ts}.${rand}`)}'>${input.elementXml}<pieceStat pid='1' start='0' number='${input.limit}' requestId='${escapeXmlAttribute(requestId)}' cleanupId='${escapeXmlAttribute(cleanupId)}'/></ajax-request>`
		const response = await postXml('_cmdstat.jsp', xml, undefined, true)
		return pickFirstRecords(response, input.tagNames)
	}

	function clampLimit(limit: number | undefined, fallback: number, max: number) {
		if (limit == null || !Number.isFinite(limit)) return fallback
		return Math.max(1, Math.min(max, Math.trunc(limit)))
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
		async listBlockedClients() {
			const xml = await getConfRaw('acl-list')
			const acls = parseElements(xml, 'acl')
			const systemAcl =
				acls.find((acl) => String(acl['id'] ?? '') === '1') ?? acls[0]
			if (!systemAcl) return []
			const aclXml = String(systemAcl['rawXml'] ?? '')
			return parseElements(aclXml, 'deny')
		},
		async listInactiveClients() {
			return await cmdstat(
				"<ajax-request action='getstat' comp='stamgr' enable-gzip='0'><clientlist period='0' /></ajax-request>",
				['client'],
			)
		},
		async listActiveRogues() {
			return await cmdstat(
				"<ajax-request action='getstat' comp='stamgr' enable-gzip='0'><rogue LEVEL='1' recognized='!true'/></ajax-request>",
				['rogue'],
			)
		},
		async listKnownRogues(limit = 300) {
			return await piecewiseCmdstat({
				comp: 'stamgr',
				elementXml: `<rogue sortBy='time' sortDirection='-1' LEVEL='1' recognized='true'/>`,
				updater: 'krogue',
				tagNames: ['rogue'],
				limit: clampLimit(limit, 300, 1000),
			})
		},
		async listBlockedRogues(limit = 300) {
			return await piecewiseCmdstat({
				comp: 'stamgr',
				elementXml: `<rogue sortBy='time' sortDirection='-1' LEVEL='1' blocked='true'/>`,
				updater: 'brogue',
				tagNames: ['rogue'],
				limit: clampLimit(limit, 300, 1000),
			})
		},
		async listApGroups() {
			return await getConf('apgroup-list', ['apgroup'])
		},
		async listDpsks() {
			return await getConf('dpsk-list', ['dpsk'])
		},
		async getMeshInfo() {
			const meshes = await getConf('mesh-list', ['mesh'])
			return meshes[0] ?? {}
		},
		async getAlarms(limit = 300) {
			return await piecewiseCmdstat({
				comp: 'eventd',
				elementXml: `<alarm sortBy='time' sortDirection='-1'/>`,
				updater: 'page',
				tagNames: ['alarm'],
				limit: clampLimit(limit, 300, 1000),
			})
		},
		async getSyslog() {
			const ts = Date.now()
			const response = await postXml(
				'_cmdstat.jsp',
				`<ajax-request action='docmd' xcmd='get-syslog' updater='system.${ts}' comp='system'><xcmd cmd='get-syslog' type='sys'/></ajax-request>`,
				undefined,
				true,
			)
			const xmsgRecords = parseElements(response, 'xmsg')
			const firstXmsg = xmsgRecords[0]
			if (firstXmsg && typeof firstXmsg['res'] === 'string') {
				return String(firstXmsg['res'])
			}
			const resMatch = /<res\b[^>]*>([\s\S]*?)<\/res>/i.exec(response)
			if (resMatch && resMatch[1] !== undefined) {
				return decodeXmlEntities(resMatch[1])
			}
			const resAttr =
				firstXmsg && typeof firstXmsg['res'] !== 'undefined'
					? firstXmsg['res']
					: null
			return resAttr == null ? '' : String(resAttr)
		},
		async getVapStats() {
			return await cmdstat(
				"<ajax-request action='getstat' comp='stamgr' enable-gzip='0' caller='SCI'><vap INTERVAL-STATS='no' LEVEL='1'/></ajax-request>",
				['vap'],
			)
		},
		async getWlanGroupStats() {
			return await cmdstat(
				"<ajax-request action='getstat' comp='stamgr' enable-gzip='0' caller='SCI'><wlangroup/></ajax-request>",
				['wlangroup', 'wlan'],
			)
		},
		async getApGroupStats() {
			return await cmdstat(
				"<ajax-request action='getstat' comp='stamgr' enable-gzip='0'><apgroup/></ajax-request>",
				['group', 'apgroup'],
			)
		},
		async setWlanPassword(name, passphrase, saePassphrase) {
			const wlanXml = await getWlanRawXml(name)
			if (!wlanXml) {
				throw new Error(
					`Access Networks Unleashed WLAN "${name}" was not found.`,
				)
			}
			const updated = applyWlanPatch(wlanXml, {
				passphrase,
				saePassphrase: saePassphrase ?? passphrase,
			})
			await postXml(
				'_conf.jsp',
				`<ajax-request action='updobj' updater='wlan' comp='wlansvc-list'>${updated}</ajax-request>`,
				20_000,
			)
		},
		async addWlan(input: AccessNetworksUnleashedAddWlanInput) {
			const template = await getDefaultWlanTemplateXml()
			const wlanName = input.name?.trim() || input.ssid
			let updated = applyWlanPatch(template, {
				name: wlanName,
				ssid: input.ssid,
				description: input.description,
				passphrase: input.passphrase,
				saePassphrase: input.saePassphrase ?? input.passphrase,
			})
			updated = removeRootIdAttribute(updated)
			await postXml(
				'_conf.jsp',
				`<ajax-request action='addobj' updater='wlansvc-list' comp='wlansvc-list'>${updated}</ajax-request>`,
				20_000,
			)
		},
		async editWlan(input: AccessNetworksUnleashedEditWlanInput) {
			const wlanXml = await getWlanRawXml(input.name)
			if (!wlanXml) {
				throw new Error(
					`Access Networks Unleashed WLAN "${input.name}" was not found.`,
				)
			}
			const patch: Parameters<typeof applyWlanPatch>[1] = {}
			if (input.ssid !== undefined) patch.ssid = input.ssid
			if (input.description !== undefined) patch.description = input.description
			if (input.passphrase !== undefined) patch.passphrase = input.passphrase
			if (input.saePassphrase !== undefined) {
				patch.saePassphrase = input.saePassphrase
			} else if (input.passphrase !== undefined) {
				patch.saePassphrase = input.passphrase
			}
			if (input.enabled !== undefined) {
				patch.enableType = input.enabled ? 0 : 1
			}
			const updated = applyWlanPatch(wlanXml, patch)
			await postXml(
				'_conf.jsp',
				`<ajax-request action='updobj' updater='wlan' comp='wlansvc-list'>${updated}</ajax-request>`,
				20_000,
			)
		},
		async cloneWlan(sourceName, newName, newSsid) {
			const sourceXml = await getWlanRawXml(sourceName)
			if (!sourceXml) {
				throw new Error(
					`Access Networks Unleashed WLAN "${sourceName}" was not found.`,
				)
			}
			let updated = removeRootIdAttribute(sourceXml)
			updated = applyWlanPatch(updated, {
				name: newName,
				ssid: newSsid ?? newName,
			})
			await postXml(
				'_conf.jsp',
				`<ajax-request action='addobj' updater='wlansvc-list' comp='wlansvc-list'>${updated}</ajax-request>`,
				20_000,
			)
		},
		async deleteWlan(name) {
			const wlan = await findWlan(name)
			if (!wlan) {
				throw new Error(
					`Access Networks Unleashed WLAN "${name}" was not found.`,
				)
			}
			await postXml(
				'_conf.jsp',
				`<ajax-request action='delobj' updater='wlansvc-list.${Date.now()}' comp='wlansvc-list'><wlansvc id='${escapeXmlAttribute(String(wlan['id'] ?? ''))}'/></ajax-request>`,
				20_000,
			)
		},
		async addWlanGroup(input: AccessNetworksUnleashedAddWlanGroupInput) {
			const description = input.description ?? ''
			let body = `<wlangroup name='${escapeXmlAttribute(input.name)}' description='${escapeXmlAttribute(description)}'>`
			if (input.wlans && input.wlans.length > 0) {
				const wlans = await getConf('wlansvc-list', ['wlansvc'])
				const wlanByName = new Map(
					wlans.map((wlan) => [String(wlan['name'] ?? ''), wlan] as const),
				)
				for (const wlanName of input.wlans) {
					const wlan = wlanByName.get(wlanName)
					if (!wlan) {
						throw new Error(
							`Access Networks Unleashed WLAN "${wlanName}" was not found.`,
						)
					}
					body += `<wlansvc id='${escapeXmlAttribute(String(wlan['id'] ?? ''))}'/>`
				}
			}
			body += `</wlangroup>`
			await postXml(
				'_conf.jsp',
				`<ajax-request action='addobj' comp='wlangroup-list' updater='wgroup'>${body}</ajax-request>`,
				20_000,
			)
		},
		async cloneWlanGroup(sourceName, newName, description) {
			const xml = await getConfRaw('wlangroup-list')
			const sourceXml = extractElementByAttribute({
				xml,
				tagName: 'wlangroup',
				attributeName: 'name',
				attributeValue: sourceName,
			})
			if (!sourceXml) {
				throw new Error(
					`Access Networks Unleashed WLAN group "${sourceName}" was not found.`,
				)
			}
			const sourceDescription = getAttributeValue(sourceXml, 'description') ?? ''
			const wlanIdMatches = sourceXml.matchAll(
				/<wlansvc\b[^>]*\bid\s*=\s*(["'])(.*?)\1[^>]*\/?>/gi,
			)
			const childIds: Array<string> = []
			for (const match of wlanIdMatches) {
				if (match[2]) childIds.push(decodeXmlEntities(match[2]))
			}
			let body = `<wlangroup name='${escapeXmlAttribute(newName)}' description='${escapeXmlAttribute(description ?? sourceDescription)}'>`
			for (const id of childIds) {
				body += `<wlansvc id='${escapeXmlAttribute(id)}'/>`
			}
			body += `</wlangroup>`
			await postXml(
				'_conf.jsp',
				`<ajax-request action='addobj' comp='wlangroup-list' updater='wgroup'>${body}</ajax-request>`,
				20_000,
			)
		},
		async deleteWlanGroup(name) {
			const xml = await getConfRaw('wlangroup-list')
			const sourceXml = extractElementByAttribute({
				xml,
				tagName: 'wlangroup',
				attributeName: 'name',
				attributeValue: name,
			})
			if (!sourceXml) {
				throw new Error(
					`Access Networks Unleashed WLAN group "${name}" was not found.`,
				)
			}
			const id = getAttributeValue(sourceXml, 'id')
			if (!id) {
				throw new Error(
					`Access Networks Unleashed WLAN group "${name}" is missing an id.`,
				)
			}
			await postXml(
				'_conf.jsp',
				`<ajax-request action='delobj' updater='wlangroup-list.${Date.now()}' comp='wlangroup-list'><wlangroup id='${escapeXmlAttribute(id)}'/></ajax-request>`,
				20_000,
			)
		},
	}

	return client
}
