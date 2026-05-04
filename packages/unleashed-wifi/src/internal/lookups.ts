import { unleashedRequest, type UnleashedRequestResult } from './request.ts'
import {
	extractElementByAttribute,
	extractElements,
	normalizeMacAddress,
	type UnleashedRecord,
} from './xml.ts'

const findWlanReason =
	'Looking up an existing Access Networks Unleashed WLAN definition before applying the requested mutation.'
const findApReason =
	'Looking up an existing Access Networks Unleashed access point before applying the requested mutation.'
const findWlanGroupReason =
	'Looking up an existing Access Networks Unleashed WLAN group before applying the requested mutation.'

async function readConfig(comp: string, xmlBody: string, reason: string) {
	const result: UnleashedRequestResult = await unleashedRequest({
		action: 'getstat',
		comp,
		xmlBody,
		reason,
	})
	return result
}

export async function findWlanByName(name: string) {
	const result = await readConfig(
		'stamgr',
		'<wlan-cfg/>',
		`${findWlanReason} (target: ${name})`,
	)
	const wlans = extractElements(result.xml, 'wlansvc')
	const wlan =
		wlans.find((entry) => String(entry['name'] ?? '') === name) ?? null
	const rawXml =
		wlan == null
			? null
			: extractElementByAttribute({
					xml: result.xml,
					tagName: 'wlansvc',
					attributeName: 'name',
					attributeValue: name,
				})
	return { wlan, rawXml }
}

export async function findWlanGroupByName(name: string) {
	const result = await readConfig(
		'stamgr',
		'<wlan-group/>',
		`${findWlanGroupReason} (target: ${name})`,
	)
	const groups = extractElements(result.xml, 'wlangroup')
	const group =
		groups.find((entry) => String(entry['name'] ?? '') === name) ?? null
	const rawXml =
		group == null
			? null
			: extractElementByAttribute({
					xml: result.xml,
					tagName: 'wlangroup',
					attributeName: 'name',
					attributeValue: name,
				})
	return { group, rawXml }
}

export async function findApByMac(mac: string) {
	const normalized = normalizeMacAddress(mac)
	const result = await readConfig(
		'apStat',
		'<apStat/>',
		`${findApReason} (target: ${normalized})`,
	)
	const aps = extractElements(result.xml, 'ap')
	const ap = aps.find((entry) => {
		const candidate = String(entry['mac'] ?? entry['mac-address'] ?? '')
		try {
			return normalizeMacAddress(candidate) === normalized
		} catch {
			return false
		}
	})
	if (ap) {
		const rawXml = extractElementByAttribute({
			xml: result.xml,
			tagName: 'ap',
			attributeName: 'mac',
			attributeValue: String(ap['mac'] ?? normalized),
		})
		return { ap: ap as UnleashedRecord, rawXml }
	}
	return { ap: null, rawXml: null }
}
