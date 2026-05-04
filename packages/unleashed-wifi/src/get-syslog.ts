import { unleashedRequest } from './internal/request.ts'
import { decodeXmlEntities, extractElements } from './internal/xml.ts'

const defaultReason =
	'Reading raw Access Networks Unleashed syslog text for operator review.'

/** Read the raw syslog buffer from the controller. */
export async function getSyslog(input: { reason?: string } = {}) {
	const result = await unleashedRequest({
		action: 'getstat',
		comp: 'system',
		xmlBody: '<syslog/>',
		reason: input.reason ?? defaultReason,
	})
	const xmsgRecords = extractElements(result.xml, 'xmsg')
	const firstXmsg = xmsgRecords[0]
	if (firstXmsg && typeof firstXmsg['res'] === 'string') {
		return { syslog: firstXmsg['res'], xml: result.xml }
	}
	const resMatch = /<res\b[^>]*>([\s\S]*?)<\/res>/i.exec(result.xml)
	if (resMatch && resMatch[1] !== undefined) {
		return { syslog: decodeXmlEntities(resMatch[1]), xml: result.xml }
	}
	const syslogBodyMatch = /<syslog\b[^>]*>([\s\S]*?)<\/syslog>/i.exec(
		result.xml,
	)
	if (syslogBodyMatch && syslogBodyMatch[1] !== undefined) {
		return { syslog: decodeXmlEntities(syslogBodyMatch[1]), xml: result.xml }
	}
	return { syslog: '', xml: result.xml }
}
