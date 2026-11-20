# Access (in Alcántara)

<!-- gaulatti/pompeii#53. Same text in Ariston, Monitor and Alcantara; replace <Service> and <slug> (auburndale, monitor, alcantara). -->

The **Access** page (user menu → Access) manages who can use Alcántara and with which tokens, without opening Pompeii. Pompeii stores everything and makes every decision; Alcántara only forwards your request with its own service credential.

## Your tokens

Anyone signed in can see, create and revoke their own personal access tokens here. Tools such as MCP clients use one to act as you.

- **Reach.** A token made here reaches only Alcántara's permissions, and only the ones you hold. Choose "All of mine in Alcántara", or pick specific permissions.
- **The value is shown once**, right after you create it. Copy it then; you won't see it again.
- **Revoke** stops the token on its next use.
- **Created in** is the service whose Access page created the token, or Pompeii.
- **Last used in** and **Last used** say which service's permission the token was last presented for, and when. That's recorded whether the check was allowed or refused, at most once a minute.
- New tokens can't be created while the token switch is off.

## Token switch and People (holders of `alcantara:access:manage`)

- **Token switch.** Whether Alcántara accepts personal access tokens at all. Turning it off refuses every token on its next call.
- **People.** Who holds Alcántara's roles. Grant a role to a person (by Pompeii user id; they must have signed in once), or revoke one. You can only grant or revoke a role whose every permission you hold yourself.
- The owner grants `alcantara:access:manage` in Pompeii's admin screen, or here once someone holds it.

## History

Access changes made through Alcántara: when, what, who, and whether from this page or from an MCP client.

## When it says "not available yet"

Alcántara has no service credential configured yet (`POMPEII_ACCESS_CREDENTIAL` in its application secret), or Pompeii's access service can't be reached. The owner issues the credential once, following Pompeii's runbook (docs/application-access.md, "Issuing service credentials").
