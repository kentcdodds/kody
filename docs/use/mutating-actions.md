# Mutating actions and confirmations

Some capabilities call **GitHub**, **Cloudflare**, **Cursor Cloud Agents**, or
other APIs that **create, update, or delete** remote data.

Before **POST**, **PUT**, **PATCH**, or **DELETE** (or any destructive or
quota-consuming agent operation), **confirm the exact path, HTTP method, and
JSON body** with the user unless they already approved that precise operation.

Official references:

- [Cursor Cloud Agent API](https://cursor.com/docs/cloud-agent/api/endpoints)
- [Cloudflare API](https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/)

The identity that owns tokens and approvals is the one configured for Kody (for
example automation accounts), not necessarily the end user’s personal account.
