<p align="center">
  <img src="docs/brand/felix-canvas-mark.png" alt="Felix Canvas: the Felix cat with a pen stroke and two cursors" width="200">
</p>

<h1 align="center">Felix Canvas</h1>

<p align="center">
  A self-hosted multiplayer drawing canvas built on <a href="https://github.com/GetFelix/felix">Felix</a>.
</p>

<p align="center">
  <a href="https://github.com/GetFelix/felix-canvas/actions/workflows/ci.yml"><img src="https://github.com/GetFelix/felix-canvas/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

Felix Canvas lets a group of people draw shapes and write rich text on one
shared canvas in the browser, see each other's cursors, and scrub back through
everything the room has done. It is for teams that want a shared whiteboard on
their own machines, signed in through their own identity provider, and for
anyone evaluating Felix who wants to see it carry a complete application.

All of a room's state lives in Felix. Edits go on a durable
[stream](https://github.com/GetFelix/felix/blob/main/docs/semantics.md#delivery-to-subscribers),
whose log offsets put them in one order and show a client exactly which ones it
missed. Cursors go on an in-memory stream that drops new messages for a viewer
that falls behind. Snapshots, the member list and per-session sequence numbers
are [cache](https://github.com/GetFelix/felix/blob/main/docs/cache-on-log.md) keys
and [counters](https://github.com/GetFelix/felix/blob/main/docs/projections.md#counters),
the member list with a TTL and a watch on the room's whole members cache. A
[consumer group](https://github.com/GetFelix/felix/blob/main/docs/projections.md#queues-read-the-log-through-a-shared-cursor)
feeds the snapshotter, and history is a read of the same stream from an earlier
offset. Each browser gets a Felix token narrowed to one room through the
control plane's
[token exchange](https://github.com/GetFelix/felix/blob/main/docs/auth.md#control-plane-token-exchange-flow).
With three brokers and `CANVAS_REPLICAS=3` (or the Helm chart's
`felix.replicas: 3`), a room keeps working when its broker dies through Felix
[replication and failover](https://github.com/GetFelix/felix/blob/main/docs/semantics.md#failover).
The compose install runs one broker, so it has no failover.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/sync-dark.png">
  <img src="docs/screenshots/sync-light.png" alt="Two people editing one room, with the sync panel open">
</picture>

## Features

- Rectangles, ellipses, lines, pen strokes and text boxes, with two people able
  to drag the same shape at once.
- Rich text in text boxes and inside shapes: bold, italic, underline, links,
  four sizes, a fixed colour palette, headings and nested lists. Two people can
  type in one box at once and see each other's carets.
- Live cursors with names, and a member list that drops a closed or crashed tab
  on its own.
- A history mode that scrubs the room back and forth through every change and
  returns to live without missing anything.
- Fast joins: a browser entering a busy room draws it from a snapshot and reads
  only the changes since.
- A slow connection falls behind alone, says so, and catches up to the same
  canvas while everyone else stays live.
- Sign-in through any OpenID Connect provider, with each room open only to the
  people you list. The broker enforces this, so a bug in the gateway cannot
  reach another room.
- Optional self-service rooms: a signed-in person creates a room, shares an
  invite link that expires or can be revoked, and removes people or deletes
  the room, within limits you set.
- On three brokers with three replicas, editing carries on when the broker
  holding a room is killed, and no acknowledged change is lost. The compose
  install has one broker, so it does not.
- Multi-arch images, a Docker Compose install and a Helm chart.

## Quick start

You need Docker or Podman, with Compose 2.20 or later. Download the compose
install from the
[latest release](https://github.com/GetFelix/felix-canvas/releases/latest) and
start it:

```bash
curl -fsSL https://github.com/GetFelix/felix-canvas/releases/download/v0.2.0/felix-canvas-compose-0.2.0.tar.gz | tar xz
cd felix-canvas-compose-0.2.0
# change FELIX_BOOTSTRAP_TOKEN and FELIX_RAFT_PEER_TOKEN in .env first
docker compose up -d
```

With Podman, run `podman compose up -d` instead (after `podman machine start`
on macOS). [Docker or
Podman](https://docs.getfelix.dev/getting-started/containers/) covers
the differences.

Open <http://localhost:8787> in two windows, continue as `ana` or `ben`, and
draw. `?room=studio` opens a second room that only `ana` may open. The
development sign-in page lets anyone in, so replace it before anyone else can
reach the install. The [self-hosting guide](docs/self-hosting.md) covers your
own identity provider, rooms and members, TLS, backups, upgrades, Kubernetes
and every setting.

To work on the code with a local gateway, snapshotter and page, follow
[docs/development.md](docs/development.md#running-locally).

## How it works

A browser speaks WebSocket to a stateless Rust gateway, which relays to Felix
over QUIC with a token narrowed to the browser's room. The gateway is
[felix-gateway](https://github.com/GetFelix/felix-gateway) 0.3.1, and the
browser talks to it through its `felix-gateway-client` package. The browser's canvas is
a fold of the room's op log in offset order, so two browsers that have applied
the same prefix hold the same canvas and can confirm it with a state hash. A
Node snapshotter folds the same log with the same `model/` code and keeps the
result in the cache, which is what makes joins fast. Each body of rich text is
a Yjs document whose updates are ordinary ops on the log, so snapshots, rejoin
and history cover text with no second path.

One room is one durable Felix stream plus a few cache keys.

| What | Felix primitive | Name |
|---|---|---|
| Edit operations | Durable stream | `canvas.ops.<room>` |
| Cursors and presence | Ephemeral stream | `canvas.presence.<room>` |
| Compacted snapshot and its log offset | Cache key | `canvas.snap.<room>/latest` |
| Who is in the room now | Cache keys with TTL (the gateway scope file's `ttl_s`) | `canvas.members.<room>/<session>` |
| Per-session sequence numbers | Counter | `canvas.seq.<room>/<session>` |
| Who may open the room | Felix RBAC role | `role:room-<room>` |
| Snapshot worker cursor | Consumer group | group `snapshotter` |
| Rooms people created, their owners and invites | Cache key, one per room | `canvas.rooms/<room>` |

[docs/design.md](docs/design.md) has the full design, including the join and
snapshot ordering, conflict resolution, text editing and failure modes. Its
section [How these are normally built](docs/design.md#how-these-are-normally-built)
compares this with other ways of building a realtime canvas.

## Status

Milestones 0 to 9 are merged. The performance targets are measured on a 4-core
Codespace in [docs/performance.md](docs/performance.md); a run on dedicated
hardware is still to do. Each milestone is a
[GitHub milestone](https://github.com/GetFelix/felix-canvas/milestones) with an
issue per piece of work.

| M | Milestone | Status |
|---|---|---|
| [0](https://github.com/GetFelix/felix-canvas/milestone/1) | A WebSocket gateway relaying publish and subscribe | Done |
| [1](https://github.com/GetFelix/felix-canvas/milestone/2) | Two browsers, shapes, offset-ordered apply | Done |
| [2](https://github.com/GetFelix/felix-canvas/milestone/3) | Snapshots and the join path | Done |
| [3](https://github.com/GetFelix/felix-canvas/milestone/4) | Presence, cursors and TTL membership | Done |
| [4](https://github.com/GetFelix/felix-canvas/milestone/5) | Slow-client isolation and gap recovery | Done |
| [5](https://github.com/GetFelix/felix-canvas/milestone/6) | History and the time scrubber | Done |
| [6](https://github.com/GetFelix/felix-canvas/milestone/7) | Per-room authorization against a real IdP | Done |
| [7](https://github.com/GetFelix/felix-canvas/milestone/8) | 500 viewers, and killing the owning broker | Done |
| [8](https://github.com/GetFelix/felix-canvas/milestone/9) | Images, a compose install, your own IdP, a Helm chart | Done |
| [9](https://github.com/GetFelix/felix-canvas/milestone/10) | Rich text in shapes | Done |

## Documentation

- [docs/design.md](docs/design.md): the data model, editing and join rules, text, failure modes and targets.
- [docs/ux.md](docs/ux.md): the UX and visual design brief the interface is built from.
- [docs/protocol.md](docs/protocol.md): how the canvas uses the gateway, and its payload formats.
- [docs/self-hosting.md](docs/self-hosting.md): installing, your own IdP, TLS, backups, upgrades, Kubernetes and every setting.
- [docs/development.md](docs/development.md): running it locally, the repository layout, the lockfile rule and CI.
- [docs/performance.md](docs/performance.md): measured results for each target, with their conditions.
- [Canvas](https://docs.getfelix.dev/built-on-felix/canvas/) in the Felix docs: how the canvas uses Felix.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) describes how code, comments and pull
requests should read. Setup and CI are in [docs/development.md](docs/development.md).

## License

MIT
