import { expect, test } from 'vitest'
import { parseAccessNetworksUnleashedXml } from './xml.ts'

test('parser correctly handles closing tags whose name shares a prefix with siblings', () => {
	// Without a strict closing-tag check, parsing the inner <ap> element would
	// see </apgroup> as its closing tag and consume it, corrupting the rest of
	// the tree. The parser must require that the closing tag name matches
	// exactly (delimited by `>` or whitespace).
	const xml =
		'<ajax-response>' +
		"<apgroup id='1' name='System Default'>" +
		"<ap mac='aa:bb:cc:dd:ee:ff' name='Kitchen'/>" +
		'</apgroup>' +
		"<apgroup id='2' name='Guest'/>" +
		'</ajax-response>'

	const parsed = parseAccessNetworksUnleashedXml(xml) as Record<string, any>
	expect(parsed['ajax-response']).toBeDefined()
	const groups = parsed['ajax-response'].apgroup as Array<Record<string, any>>
	expect(Array.isArray(groups)).toBe(true)
	expect(groups).toHaveLength(2)
	expect(groups[0]?.['@id']).toBe('1')
	expect(groups[1]?.['@id']).toBe('2')
	expect(groups[0]?.ap).toMatchObject({ '@mac': 'aa:bb:cc:dd:ee:ff' })
})

test('parser keeps text content inside leaf elements', () => {
	const xml =
		'<ajax-response><xmsg><res>line1\nline2</res></xmsg></ajax-response>'
	const parsed = parseAccessNetworksUnleashedXml(xml) as Record<string, any>
	expect(parsed['ajax-response']?.xmsg?.res).toBe('line1\nline2')
})
