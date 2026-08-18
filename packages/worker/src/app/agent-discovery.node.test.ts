import { expect, test } from 'vitest'
import { listBlogPosts } from '#worker/blog/catalog.ts'
import { listGuides } from '#worker/guides/catalog.ts'
import {
	agentSkillMarkdownPath,
	agentSkills,
	buildAgentSkillsIndex,
	buildApiCatalog,
	buildAuthMarkdown,
	buildHomeMarkdown,
	buildMcpServerCard,
	buildRobotsTxt,
	buildSecurityTxt,
	buildSitemapXml,
	formatLinkHeader,
	getAgentSkill,
	kodyMcpServerCardVersion,
	listAgentDiscoveryLinks,
	listPublicSitemapEntries,
	mcpResourcePath,
	sha256Hex,
	withAgentDiscoveryLinkHeaders,
} from './agent-discovery.ts'

const origin = 'https://kody.example'

test('agent discovery documents describe the MCP server and public pages', async () => {
	const robots = buildRobotsTxt(origin)
	expect(robots).toContain('User-agent: *')
	expect(robots).toContain('User-agent: GPTBot')
	expect(robots).toContain('User-agent: ClaudeBot')
	expect(robots).toContain(
		'Content-Signal: search=yes, ai-input=yes, ai-train=no',
	)
	expect(robots).toContain('Disallow: /account')
	expect(robots).toContain('Disallow: /auth/')
	expect(robots).not.toContain('Disallow: /auth.md')
	expect(robots).toContain(`Sitemap: ${origin}/sitemap.xml`)

	const sitemap = buildSitemapXml(origin)
	expect(sitemap).toContain(
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
	)
	expect(sitemap).toContain(`<loc>${origin}/</loc>`)
	expect(sitemap).toContain(`<loc>${origin}/auth.md</loc>`)
	for (const guide of listGuides()) {
		expect(sitemap).toContain(`<loc>${origin}/guides/${guide.slug}</loc>`)
	}
	for (const post of listBlogPosts()) {
		expect(sitemap).toContain(`<loc>${origin}/blog/${post.slug}</loc>`)
		expect(sitemap).toContain(`<lastmod>${post.date}</lastmod>`)
	}
	expect(
		listPublicSitemapEntries().some((entry) => entry.path === '/account'),
	).toBe(false)

	const card = buildMcpServerCard(origin)
	expect(card.serverInfo).toEqual({
		name: 'Kody',
		version: kodyMcpServerCardVersion,
	})
	expect(card.url).toBe(`${origin}${mcpResourcePath}`)
	expect(card.transport).toEqual({
		type: 'streamable-http',
		endpoint: `${origin}${mcpResourcePath}`,
	})
	expect(card.capabilities.tools).toBe(true)

	const catalog = buildApiCatalog(origin)
	expect(catalog.linkset[0]?.anchor).toBe(`${origin}${mcpResourcePath}`)
	expect(catalog.linkset[0]?.['service-desc']?.[0]?.href).toBe(
		`${origin}/.well-known/mcp/server-card.json`,
	)

	const authMd = buildAuthMarkdown(origin)
	expect(authMd.startsWith('# auth.md\n')).toBe(true)
	expect(authMd).toContain('"skill": "connect-kody"')
	expect(authMd).toContain(`"register_uri": "${origin}/oauth/register"`)
	expect(authMd).toContain(`${origin}${mcpResourcePath}`)

	const homeMd = buildHomeMarkdown(origin)
	expect(homeMd.startsWith('# Kody\n')).toBe(true)
	expect(homeMd).toContain(`${origin}${mcpResourcePath}`)
	expect(homeMd).toContain(`${origin}/guides/what-is-kody.md`)

	const now = new Date('2026-08-18T20:00:00.000Z')
	const securityTxt = buildSecurityTxt(origin, now)
	expect(securityTxt).toContain('Contact: mailto:me@kentcdodds.com')
	expect(securityTxt).toContain(
		'Contact: https://github.com/kentcdodds/kody/security/advisories/new',
	)
	expect(securityTxt).toContain('Expires: 2027-08-18T20:00:00.000Z')
	expect(securityTxt).toContain(`Canonical: ${origin}/.well-known/security.txt`)

	expect(
		getAgentSkill('connect-kody')?.body.startsWith('# Connect Kody\n'),
	).toBe(true)
	expect(getAgentSkill('missing')).toBeNull()
	const index = await buildAgentSkillsIndex(origin)
	expect(index.skills).toHaveLength(agentSkills.length)
	const connect = index.skills.find((skill) => skill.name === 'connect-kody')
	expect(connect?.url).toBe(
		`${origin}${agentSkillMarkdownPath('connect-kody')}`,
	)
	expect(connect?.digest).toBe(
		`sha256:${await sha256Hex(getAgentSkill('connect-kody')?.body ?? '')}`,
	)

	const links = listAgentDiscoveryLinks(origin)
	const header = formatLinkHeader(links)
	expect(header).toContain(
		`<${origin}/.well-known/api-catalog>; rel="api-catalog"`,
	)
	expect(header).toContain(`rel="describedby"`)
	expect(header).toContain(`rel="service-doc"`)
	const withLinks = withAgentDiscoveryLinkHeaders(
		new Response('ok', { headers: { 'Content-Type': 'text/html' } }),
		origin,
	)
	expect(withLinks.headers.get('link')).toBe(header)
	expect(withLinks.headers.get('content-type')).toBe('text/html')
})
