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

## Local browser check

`scripts/access-fake/` runs the Access screen in a browser with no Pompeii and no Cognito. It is a local check tool: it is not in any image or deploy path (the backend and frontend images build from `backend/` and `frontend/` only).

```sh
export BACKEND_PORT=3224 VITE_PORT=5224 LOCALSTACK_PORT=4724   # any free ports
docker compose -p a224 -f compose.yml -f scripts/access-fake/compose.yml up --build -d backend frontend access-fake
# open http://localhost:5224/access (TEST AUTH signs you in)
FAKE_CALLER=member docker compose -p a224 -f compose.yml -f scripts/access-fake/compose.yml up -d --force-recreate --no-deps access-fake
docker compose -p a224 -f compose.yml -f scripts/access-fake/compose.yml down -v
```

The fake serves `pompeii.access.v1.ApplicationAccessService` (plain gRPC, in memory, state resets when it restarts). It holds the name `host.docker.internal` on the Compose network, which is the address the backend already uses outside production, so no new setting exists. The override only adds a fake `POMPEII_ACCESS_CREDENTIAL` (`pmp_svc_FAKE...`, not a real credential) to the local backend.

| Do this | You see |
| --- | --- |
| Open `/access` | My tokens, Token switch, People, History tabs |
| Create a token | The value once, with a copy button; gone after reload or another tab |
| Revoke it | It leaves the list |
| Turn the Token switch off, then create | "Personal access tokens are switched off here, so new ones cannot be created." |
| Grant a role to a user id, then revoke it | The person appears in People and leaves; History records each change |
| Token named `FORBIDDEN` | "You are not allowed to do that." |
| Token named `BADARG` | "That request was not accepted. Check what you entered." |
| Token named `DOWN`, or grant to user id `503` | "Access is not available yet" |
| Revoke something already revoked in another tab | "That record no longer exists." and the list refreshes |
| `FAKE_CALLER=member` | Only My tokens and History; no Token switch or People |
