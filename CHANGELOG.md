# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Felix Canvas is pre-1.0: the browser protocol, the op format and the install
settings may change between minor versions. Each release notes the Felix
version it was tested against.

## [Unreleased]

### Fixed

- The failover e2e test no longer fails now and then on a cluster that has just
  started. Felix places a shard on whichever brokers are live when it is
  created, so a broker that reported in late could be missing from some
  shards, and stopping another one then left those shards without a majority
  ([GetFelix/felix#1151](https://github.com/GetFelix/felix/issues/1151),
  [#1153](https://github.com/GetFelix/felix/issues/1153)). In the three-broker
  dev stack the seed now creates the rooms only once every broker is live, and
  `dev/up.sh --cluster` and the test both check that every shard has all its
  copies.

## [0.3.0] - 2026-10-10

Tested against Felix 0.6.0-preview.5 and felix-gateway 0.3.1, which the
install now pins. The page caps its own writes so fast drawing stays under the
gateway's new limits, a person can have 16 sessions open instead of 8, and the
"Up to date" notice no longer names a stale version after catching up.
Self-service rooms and invite links are new and off by default.

### Added

- Self-service rooms, off unless you turn them on: a signed-in person creates
  a room from the list under the room name, shares invite links that expire
  after `CANVAS_INVITE_TTL_HOURS` or when revoked, removes people and deletes
  the room. The new rooms service runs from the snapshotter image and holds
  the Felix admin credential; the compose install adds it with `rooms.yaml`
  and `CANVAS_INVITE_SECRET`, and the chart with `selfService.enabled`.
  `CANVAS_ROOMS_PER_USER`, `CANVAS_MEMBERS_PER_ROOM` and
  `CANVAS_INVITES_PER_ROOM` set the limits (#79).

### Changed

- The gateway is felix-gateway 0.3.1, and the page uses `felix-gateway-client`
  0.3.1. The gateway now refuses a session's writes past 50 a second (bursts
  of 100), so the page paces its own: ops at most 20 a second with bursts of
  40, a drag waiting on that budget folding into one op per shape, and
  presence at most 25 a second instead of 60. The scope file turns off the
  gateway's per-address session cap, which behind Caddy or an ingress would
  count every browser as the proxy, allows 16 sessions per person instead of
  8, and lets an op carry up to 256 KiB. A
  chart install that sets its own `gateway.scope` should add the same
  `[limits]` settings.
- Built on Felix 0.6.0-preview.5: the dev stack, the compose install and the
  chart's CI run the 0.6.0-preview.5 images. The snapshotter uses
  `felix-client` 0.6.0-preview.4.
- The seed also creates the `canvas.rooms` cache, and the snapshotter folds
  every room listed there besides `CANVAS_ROOMS`, starting and stopping as
  rooms are created and deleted, without a restart (#79).
- `dev/up.sh` and the failover test run on Docker or Podman, and the docs show
  the Podman commands.

### Fixed

- After a slow connection caught up, the notice's "Up to date · version" could
  name the version from the moment of catching up while changes still on their
  way landed under it. It now follows them while it shows.

## [0.2.0] - 2026-10-04

Tested against Felix 0.6.0-preview.2, which the install now pins. Felix images
come from `ghcr.io/getfelix`. Upgrading means renaming any `CANVAS_*` gateway
override to `GATEWAY_*` (see below).

### Changed

- The gateway is now the published felix-gateway 0.1.0. The canvas image is
  built on `ghcr.io/getfelix/felix-gateway:0.1.0`, the page uses
  `felix-gateway-client` from npm, and `gateway/` and `packages/gateway-client/`
  are gone. The gateway reads `GATEWAY_*` variables instead of `CANVAS_*`; the
  compose file and the chart set them, but a gateway override such as
  `gateway.extraEnv` that sets `CANVAS_*` must be renamed. The image's scope
  file moved to `/etc/felix-gateway/scope.toml`.
- The snapshotter uses `felix-client` 0.6.0-preview.2.

## [0.1.0] - 2026-10-03

The first release. Tested against Felix 0.6.0-preview.

### Added

- A stateless Rust gateway that serves the web page and relays each browser's
  WebSocket session to Felix over QUIC. (#2)
- Shapes on a shared canvas: rectangles, ellipses, lines and pen strokes. A
  room's canvas is the fold of its op log in offset order, so browsers that have
  applied the same records hold the same canvas and can confirm it with a state
  hash. Two people can drag the same shape at once. (#29)
- Snapshots and fast joins. A Node snapshotter reads each room's log through a
  Felix consumer group, folds it with the same `model/` code as the browser,
  and keeps the result in the Felix cache. A joining browser draws from the
  snapshot and reads only the changes after it. (#37)
- Live cursors with names, and a member list kept as cache keys with a TTL, so
  a closed or crashed tab drops out on its own. (#36)
- Slow-client isolation and gap recovery. A browser that misses records sees
  the jump in offsets, says it is behind, and catches up to the same canvas
  while everyone else stays live. (#40)
- A history mode that scrubs a room back and forth through every change and
  returns to live without missing anything. (#41)
- Per-room authorization. Browsers sign in through any OpenID Connect provider,
  the gateway exchanges the sign-in for a Felix token narrowed to one room, and
  the broker refuses that token on every other room's streams, counters,
  snapshot and member list. (#39)
- Scale and failover: measured publish latency with 500 viewers, and a
  three-broker setup in which editing carries on when the broker holding a
  room's log is killed, with no acknowledged change lost. (#53)
- Release images `ghcr.io/getfelix/felix-canvas` and
  `ghcr.io/getfelix/felix-canvas-snapshotter` for `linux/amd64` and
  `linux/arm64`, signed with cosign; a Docker Compose install with no database
  beside Felix; a Dex example for your own identity provider; and a Helm chart
  that installs next to the Felix chart. (#51, #52)
- Rich text in text boxes and inside rectangles and ellipses: bold, italic,
  underline, links, four sizes, a colour palette, headings and nested lists.
  Each body is a Yjs document whose updates are ordinary ops on the log, so
  snapshots, rejoin and history cover text too. Two people can type in one box
  at once and see each other's carets. (#56, #57, #58)

### Fixed

- A person's name and colour come from the account they signed in with.
  Two accounts signed in from windows of one browser were shown as one person,
  because the name and identity lived in shared local storage. (#55)
