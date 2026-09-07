# Operator console preferences

Alcantara owns console UI preferences. Pompeii supplies both the authenticated
pool subject and, when verified, its canonical principal; Pompeii does not store
these preferences. The legacy primary key remains `(subject, deviceClass)`, but
reads query both `(principalId, deviceClass)` and the current
`(subject, deviceClass)` together. Two linked pool identities therefore reach
one migrated profile, while an unresolved identity can reach only its legacy
row. Distinct matches fail with `CANONICAL_IDENTITY_COLLISION`; a canonical row
must never hide a separate legacy profile for the current subject.

## Device classification and override

Director and Graphics reserve the lower workspace for staged-scene properties;
the full mixer, playlist, instants and playback bar live in Audio. Audio keeps a
small Program confidence monitor, without the scene grid or video switcher.
Confidence monitors have bounded height and the scene strip scrolls independently.
The properties workspace retains at least 420 px of height; smaller windows can
scroll the console instead of clipping the editor. Switching workspaces does not
change the staged scene or take anything on air.

Classification is deterministic at browser startup:

- `phone`: iPhone, iPod, Android Mobile, or a viewport under 768 px
- `tablet`: iPad/tablet user agent, touch-capable iPadOS reporting `MacIntel`,
  or a viewport from 768 through 1179 px
- `desktop`: every other browser at 1180 px or wider

The preferences panel can override that class on the current browser. The
override is local to that device and does not edit any server profile. “Use
detected” removes it.

## Profile and version contract

Each profile contains workspace/distribution, dock width where supported,
touch mode, keyboard shortcuts, selected program, and a transition keyed by
program. Phone profiles always use compact/touch behavior, disable shortcuts,
and omit dock width. Invalid or unsupported values are normalized by the
backend rather than copied between classes.

The browser fetches `GET /operator-preferences/:deviceClass` after
authentication. A missing row returns safe class defaults at version zero.
Changes are sent after a bounded 700 ms debounce with the last acknowledged
version. The backend update is atomic. A stale version returns HTTP 409 with
the authoritative value, and the UI offers “Use server” or “Retry mine”; it
never silently overwrites the other session.

The last acknowledged profile is cached locally under the canonical principal
when the backend returns one, with the current subject as the rollout fallback.
On the first upgraded session, Alcantara prefers an existing principal cache,
then copies a valid legacy subject cache to the principal key when needed. If the
backend is unavailable, Alcantara therefore starts with the available cache or
safe defaults, marks synchronization degraded, and leaves broadcast controls usable.
Dirty writes and clean reads retry every five seconds. Tokens are not stored in
that preference cache.

“Reset class” deletes the caller's matching subject/canonical server row and
local cache. “Reset all” deletes that caller's subject and canonical preference
rows for all three classes and clears both forms of local cache. Neither
operation affects shared layouts or another operator.

## Shared program and team layouts

Publication is an explicit action in the preferences panel. A layout stores a
name, optional description, owner subject, nullable canonical owner, `program`
or `team` scope and ID, source device class, version, timestamps, and the
normalized profile. Publishing the same name in the same scope creates a new
version; retiring also increments the version and removes it from discovery.

Discovery and load require access to the referenced program or team. Publish,
replace, and retire additionally require `alcantara:layout:manage`. Those checks
run in the backend, including team-ID matching, so bypassing the UI does not
weaken them. Loading is always deliberate and copies the shared profile into
the authenticated operator's current class-specific row. A source-class
mismatch returns HTTP 409; there is no implicit cross-class conversion.

Shared layouts contain only the profile fields above. They never include
secrets, media, live scene state, playback state, or anyone else's private
profile.

## Local verification and observability

Compose seeds `operator-a` for desktop, tablet, and phone; `operator-b` and
`viewer` desktop profiles; and a fictional program layout named “Local
rehearsal.” Re-running the seed resets those fixtures deterministically.

The backend publishes the bounded Prometheus family
`alcantara_operator_preference_operations_total{action,result}` through the
existing authenticated `/metrics` endpoint. Actions cover reads, writes,
conflicts, reset, publish, load, and retire; subjects, layout names, program
IDs, and team IDs are never metric labels.
