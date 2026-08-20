import { escapeHtml } from '@kody-internal/shared/escape-html.ts'

/**
 * Shared layout for every transactional email Kody sends. Table-based with
 * inline styles because email clients strip most modern CSS; the
 * `prefers-color-scheme` block below is a progressive enhancement for the
 * clients that do honor a `<style>` element.
 */

type EmailAction = {
	label: string
	url: string
}

type EmailIllustration = {
	/** Site-relative path resolved against `appBaseUrl`. */
	src: string
	alt: string
	width: number
	height: number
}

export type TransactionalEmailContent = {
	/** Absolute origin used to load the Kody mark; keeps the image reachable from mail clients. */
	appBaseUrl: string
	/** Subject line, also used as the document title. */
	subject: string
	/** Short line clients show next to the subject in the inbox list. */
	preheader: string
	/** Large headline at the top of the card. */
	heading: string
	/** Body paragraphs shown above the action button. */
	body: Array<string>
	/** Primary call to action. */
	action?: EmailAction
	/** Paragraphs shown below the action button, above the footer. */
	afterAction?: Array<string>
	/** Optional decorative image centered at the bottom of the card. */
	illustration?: EmailIllustration
	/** Small muted line at the very bottom of the card. */
	footnote?: string
}

export type RenderedEmail = {
	subject: string
	html: string
	text: string
}

const colors = {
	canvas: '#eef1f0',
	card: '#ffffff',
	border: '#dfe4e2',
	text: '#22262b',
	muted: '#5c6570',
	accent: '#12813f',
	accentText: '#ffffff',
}

const fontStack =
	"'Wix Madefor Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const displayFontStack =
	"'Bricolage Grotesque', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

function paragraphs(values: Array<string>, className: string, style: string) {
	return values
		.map(
			(value) =>
				`<p class="${className}" style="${style}">${escapeHtml(value)}</p>`,
		)
		.join('\n                ')
}

export function renderTransactionalEmail(
	content: TransactionalEmailContent,
): RenderedEmail {
	const bodyStyle = `margin: 0 0 16px; font-family: ${fontStack}; font-size: 16px; line-height: 1.6; color: ${colors.text};`
	const mutedStyle = `margin: 0 0 16px; font-family: ${fontStack}; font-size: 14px; line-height: 1.6; color: ${colors.muted};`
	const markUrl = new URL(
		'/images/kody-mark.png',
		content.appBaseUrl,
	).toString()
	const action = content.action
	const actionBlock = action
		? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
              <tr>
                <td align="center" bgcolor="${colors.accent}" style="border-radius: 999px;">
                  <a href="${escapeHtml(action.url)}" class="kody-button" style="display: inline-block; padding: 14px 28px; font-family: ${fontStack}; font-size: 16px; font-weight: 600; line-height: 1; color: ${colors.accentText}; text-decoration: none; border-radius: 999px;">${escapeHtml(action.label)}</a>
                </td>
              </tr>
            </table>
            <p class="kody-muted" style="${mutedStyle}">Button not working? Paste this link into your browser:<br /><a href="${escapeHtml(action.url)}" class="kody-link" style="color: ${colors.accent}; word-break: break-all;">${escapeHtml(action.url)}</a></p>`
		: ''
	const illustration = content.illustration
	const illustrationBlock = illustration
		? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 8px 0 0;">
              <tr>
                <td align="center">
                  <img src="${escapeHtml(new URL(illustration.src, content.appBaseUrl).toString())}" alt="${escapeHtml(illustration.alt)}" width="${illustration.width}" height="${illustration.height}" style="display: block; margin: 0 auto; width: ${illustration.width}px; height: ${illustration.height}px; border: 0;" />
                </td>
              </tr>
            </table>`
		: ''

	const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${escapeHtml(content.subject)}</title>
    <style>
      @media (prefers-color-scheme: dark) {
        .kody-canvas { background-color: #16191c !important; }
        .kody-card { background-color: #23272b !important; border-color: #34393e !important; }
        .kody-text { color: #f0f2f3 !important; }
        .kody-muted { color: #b3bac1 !important; }
        .kody-link { color: #6fd08c !important; }
      }
    </style>
  </head>
  <body class="kody-canvas" style="margin: 0; padding: 0; background-color: ${colors.canvas};">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${escapeHtml(content.preheader)}</div>
    <table role="presentation" class="kody-canvas" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${colors.canvas}; padding: 32px 16px;">
      <tr>
        <td align="center">
          <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px;">
            <tr>
              <td style="padding-bottom: 20px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding-right: 10px;" valign="middle">
                      <img src="${escapeHtml(markUrl)}" alt="Kody" width="34" height="34" style="display: block; width: 34px; height: 34px; border: 0;" />
                    </td>
                    <td valign="middle">
                      <span class="kody-text" style="font-family: ${displayFontStack}; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; color: ${colors.text};">Kody</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td class="kody-card" style="background-color: ${colors.card}; border: 1px solid ${colors.border}; border-radius: 14px; padding: 32px;">
                <h1 class="kody-text" style="margin: 0 0 16px; font-family: ${displayFontStack}; font-size: 24px; line-height: 1.25; font-weight: 700; letter-spacing: -0.02em; color: ${colors.text};">${escapeHtml(content.heading)}</h1>
                ${paragraphs(content.body, 'kody-text', bodyStyle)}${actionBlock}
                ${content.afterAction?.length ? paragraphs(content.afterAction, 'kody-muted', mutedStyle) : ''}${illustrationBlock}
              </td>
            </tr>
            ${
							content.footnote
								? `<tr>
              <td class="kody-muted" style="padding: 20px 8px 0; font-family: ${fontStack}; font-size: 13px; line-height: 1.6; color: ${colors.muted};">${escapeHtml(content.footnote)}</td>
            </tr>`
								: ''
						}
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>
  </body>
</html>`

	const text = [
		content.heading,
		...content.body,
		...(action ? [`${action.label}: ${action.url}`] : []),
		...(content.afterAction ?? []),
		...(content.footnote ? [content.footnote] : []),
	].join('\n\n')

	return { subject: content.subject, html, text }
}
