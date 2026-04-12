# Troubleshooting

## Search returns no good matches

- **Rephrase the query** using domain vocabulary from the search tool’s domain
  hints (for example “GitHub”, “Cloudflare”, “meta skills”).
- Try **`meta_list_capabilities`** for the full live registry, including dynamic
  capabilities.
- **`entity: "id:capability"`** looks up a **known** id. It does **not** turn an
  empty ranked **`query`** into better matches — rephrase or list capabilities
  instead.

## Saved skills or apps missing

Saved skills and apps require an **authenticated MCP user**. If the client is
not signed in, user-scoped results are empty.

## Fetch or secret errors

- **Host not approved:** complete the approval flow in the app for that secret
  and host.
- **Capability not allowed for secret:** adjust the secret’s allowed-capability
  policy or use a capability that is on the allowlist.

## Home automation

If home-related tools appear missing, check connector status with
**`meta_list_remote_connector_status`** (all attached remote connectors) or
**`meta_get_home_connector_status`** (first **`home`** connector only) when
those capabilities are available. For protocol and URL requirements, see
[Remote connectors](../contributing/architecture/remote-connectors.md).
