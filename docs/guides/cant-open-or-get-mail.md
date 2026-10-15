---
id: cant_open_or_get_mail
title: If you can't open kody.codes or get mail from us
summary:
  Unblock NextDNS and similar DNS filters for kody.codes, and recover missing
  signup or verification mail on Fastmail and other providers.
category: platform
---

# If you can't open kody.codes or get mail from us

## Site won't load (NextDNS or similar DNS filters)

NextDNS and some other DNS filters only block `.codes` if someone turned on TLD
blocking or another security list matched the domain. It is not blocked for
every NextDNS user by default.

**Fix:** In [my.nextdns.io](https://my.nextdns.io) → your profile →
**Allowlist**, add `kody.codes` (that covers subdomains too). If `.codes` was
added under Security → Block Top-Level Domains, remove it. Check **Logs** to see
which rule fired.

## Signup or verification email never arrives (Fastmail and others)

Our SPF, DKIM, and DMARC for `kody.codes` are set up correctly. Filters still
sometimes junk or drop mail from a newer domain.

**Fastmail (strongest fix):** add `*@kody.codes` as a contact — mail from
contacts skips greylisting and gets a clean spam score. If something already
landed in Spam, open it and choose **Not spam**. Also check Blocked senders.
Prefer Standard spam protection over Aggressive.

**Any provider:** check Spam/Junk, then whitelist `kody.codes` /
`noreply@kody.codes` (exact steps vary). If you still get nothing, try social
login on the signup page, or [contact support](https://kody.codes/support) with
the address you used.

## For support / agents

Ask for: provider (Gmail, Fastmail, etc.), whether mail was rejected vs silent,
and if possible full headers or bounce text (`X-Spam-score`,
`X-Spam-sender-reputation` on Fastmail).
