# Self-hosting Felix Canvas

How to run Felix Canvas on your own machines: the compose install, signing in
with your own identity provider, rooms people make themselves, TLS, backups,
upgrades, and every setting the gateway, the snapshotter, the rooms service and
the seed read.

## What runs

| Service | Image | Holds state? | Job |
|---|---|---|---|
| `gateway` | `ghcr.io/getfelix/felix-canvas` | No | [felix-gateway](https://github.com/GetFelix/felix-gateway) 0.3.2 with the web page and the canvas's scope file added. Serves the page and `/ws` from one origin, exchanges each browser's sign-in for a Felix token narrowed to one room, and relays to Felix |
| `snapshotter` | `ghcr.io/getfelix/felix-canvas-snapshotter` | No | Keeps each room's folded state in the Felix cache, so joining a busy room is fast |
| `broker` | `ghcr.io/getfelix/felix-broker` | Yes, `felix-data` | Felix: every room's op log, snapshots, member list and counters |
| `controlplane` | `ghcr.io/getfelix/felix-controlplane` | Yes, `controlplane-data` | Felix: the tenant, rooms, roles and token exchange, kept in its own Raft log |
| `seed` | the snapshotter image | No | Runs at each start: creates the tenant, the rooms and their roles, and the list self-service rooms are kept in, and writes the broker's and snapshotter's tokens |
| `tokens` | the snapshotter image | No | Signs in the seed's service accounts; never published |
| `certs` | the gateway image | Writes `state` | Makes the broker a TLS certificate on first start |
| `idp` | the snapshotter image | No | The development sign-in page, while you try it out |
| `rooms` | the snapshotter image | No | Only with `rooms.yaml`. Lets signed-in people create rooms and invite others; see [Self-service rooms](#self-service-rooms) |
| `edge` | `docker.io/library/caddy` | No | Only with `rooms.yaml`. Serves the canvas in the gateway's place, sending `/api/` to `rooms` |

The install pins Felix 0.6.0-preview.5.

Both canvas images are built for `linux/amd64` and `linux/arm64` and signed
with cosign by the images workflow when a release is published. The release notes
list each image's digest. To check one before you run it:

```bash
cosign verify ghcr.io/getfelix/felix-canvas:0.3.1 \
  --certificate-identity-regexp 'https://github.com/GetFelix/felix-canvas/.github/workflows/images.yml@refs/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The Helm chart is published as `oci://ghcr.io/getfelix/charts/felix-canvas` and
signed by the release workflow:

```bash
cosign verify ghcr.io/getfelix/charts/felix-canvas:0.3.1 \
  --certificate-identity-regexp 'https://github.com/GetFelix/felix-canvas/.github/workflows/release.yml@refs/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Install with Docker Compose

You need Docker or Podman with Compose 2.20 or later, about 2 cores and 2 GB
of memory, and disk for the drawings: a fresh install with two rooms takes about 100 MB,
because the broker reserves a segment up front for each log a room writes to
(see `FELIX_SEGMENT_BYTES`).

1. Download the compose bundle attached to a
   [release](https://github.com/GetFelix/felix-canvas/releases). It holds
   `deploy/compose/` from that release, with the image tags defaulting to the
   release's version:

   ```bash
   curl -fsSL https://github.com/GetFelix/felix-canvas/releases/download/v0.3.1/felix-canvas-compose-0.3.1.tar.gz | tar xz
   cd felix-canvas-compose-0.3.1
   ```

   `SHA256SUMS` on the same release has its checksum.

2. Edit `.env`. Change `FELIX_BOOTSTRAP_TOKEN` and `FELIX_RAFT_PEER_TOKEN`
   before the first start: the bootstrap token can create tenants and cluster
   credentials, and the peer token can replace the Felix metadata.

3. Start it:

   ```bash
   docker compose up -d
   ```

4. Open <http://localhost:8787> in two windows, continue as `ana` or `ben`, and
   draw. `?room=studio` opens the other room, which only `ana` may open.

The development sign-in page signs in anyone who picks a name, which is fine on
your own machine and nowhere else. The next section replaces it.

`docker compose logs -f gateway` shows the gateway, and
`docker compose ps` shows what is healthy. The canvas is ready once the
gateway is.

### With Podman

Every `docker` command here works as `podman`, `docker compose` as
`podman compose`. Where they differ:

- `podman compose` runs a compose provider. Use `docker-compose` 2.20 or
  later as the provider; the compose files are tested with it, not with
  `podman-compose`.
- On macOS, `podman machine start` first.
- Rootless Podman on Linux cannot publish ports below 1024, which matters for
  the Caddy proxy's 80 and 443 under [TLS](#tls). Lower
  `net.ipv4.ip_unprivileged_port_start` or run that proxy rootful.
- On SELinux hosts, bind mounts need a relabel: `ro,z` on the
  `dex-config.yaml` mount in `dex.yaml`, and `-v "$PWD":/out:Z` in the backup
  commands.

[Docker or Podman](https://docs.getfelix.dev/getting-started/containers/)
in the Felix docs has the rest.

## Your own identity provider

The canvas signs people in with any OpenID Connect provider (Keycloak, Dex,
Entra ID, Okta, Auth0, Google and others), and Felix decides who may open which
room.

**At the provider**, register a single-page application (a public client):

| Setting | Value |
|---|---|
| Grant | Authorization code with PKCE (S256), no client secret |
| Redirect URI | The canvas's origin with a trailing slash, such as `https://canvas.example.com/` |
| Scopes | `openid profile`, plus whatever your subject claim needs, such as `email` |
| Allowed origins (CORS) | The canvas's origin. The page calls discovery and the token endpoint itself |

**In `.env`**, point the install at it and stop the development page:

```bash
COMPOSE_PROFILES=
CANVAS_OIDC_ISSUER=https://login.example.com/realms/canvas
CANVAS_OIDC_CLIENT_ID=felix-canvas
CANVAS_OIDC_SCOPES=openid profile email
CANVAS_OIDC_SUBJECT_CLAIM=email
CANVAS_OIDC_JWKS_URL=
CANVAS_ROOMS=lobby=ana@example.com,ben@example.com studio=ana@example.com
```

`CANVAS_OIDC_ISSUER` must match the ID token's `iss` exactly. Leave
`CANVAS_OIDC_JWKS_URL` empty when the seed and the control plane can reach the
issuer's discovery document; set it when they reach the provider at another
address than browsers do, as the Dex example below does.

Then `docker compose up -d`. The seed adds the provider to the tenant's
trusted issuers, with the client ID as the audience an ID token must carry.

Felix accepts only ES256 ID tokens unless told otherwise. The compose file sets
`FELIX_OIDC_ALGORITHMS=ES256,RS256`, which covers most providers.

**Who may open a room** is a Felix role per room, `role:room-<room>`. The seed
assigns it to each member listed in `CANVAS_ROOMS`: a value of the subject
claim, or `group:<name>` for everyone in a provider group when
`CANVAS_OIDC_GROUPS_CLAIM` names the claim your provider puts groups in.
Prefer a claim your provider keeps stable and unique: Dex's `sub`, for
example, is an opaque encoding, so the example uses `email`.

### Example: Dex

`deploy/compose/dex.yaml` adds [Dex](https://dexidp.io) with two local users,
`ana@example.com` and `ben@example.com`, password `password`. CI runs the
install this way on every pull request.

```bash
docker compose --env-file .env --env-file dex.env -f docker-compose.yml -f dex.yaml up -d
```

`dex.env` holds the settings above for Dex. Browsers reach Dex on
`127.0.0.1:5556`, and the control plane fetches its keys at `http://dex:5556`
on the compose network, which is why `CANVAS_OIDC_JWKS_URL` is set.

## Rooms and members

Add a room or a member to `CANVAS_ROOMS` and run `docker compose up -d`. The
seed runs at every start and creates whatever is missing; the snapshotter is
recreated with the new list.

The seed never removes anything. To take someone out of a room, delete their
assignment through the Felix control plane with an admin token, or remove the
room from `CANVAS_ROOMS` to stop snapshotting it. A removed member loses access
at their session's next token refresh.

Each room is two streams and three caches in Felix, one shard each:
`canvas.ops.<room>` (durable) and `canvas.presence.<room>` (in memory), and
`canvas.seq.<room>`, `canvas.snap.<room>` and `canvas.members.<room>`.
[design.md](design.md#authorization) explains why every room has its own.

The snapshotter folds every room in `CANVAS_ROOMS`, and every room people
created when [self-service rooms](#self-service-rooms) are on.

The gateway learns those names from its scope file, `deploy/scope.toml`, which
the image carries at `/etc/felix-gateway/scope.toml`. The seed creates the same
names, so leave the file as it is unless you change both. felix-gateway's
[configuration reference](https://github.com/GetFelix/felix-gateway/blob/v0.3.2/docs/configuration.md#the-scope-file)
describes the format.

The scope file also sets the gateway's
[write limits](https://github.com/GetFelix/felix-gateway/blob/v0.3.2/docs/configuration.md#write-limits).
The canvas keeps the gateway's rates, 50 writes a second per session and 100
per person, and paces its own writes below them. It turns off the cap of 32
sessions per client address, because behind Caddy or an ingress every browser
comes from the proxy's address, and it lets an op carry up to 256 KiB so a
long pen stroke fits. Each person may hold 16 sessions at once rather than the
gateway's 8: a tab holds one, and a second while its history timeline is
open, and a session whose network vanished, such as a laptop going to sleep,
keeps its slot until the gateway's heartbeat closes it. The gateway pings every
session every 5 seconds and closes one that has sent nothing for 30;
`GATEWAY_PING_INTERVAL_S` and `GATEWAY_PING_TIMEOUT_S` change those times.

## Self-service rooms

With self-service rooms on, anyone who can sign in can create a room from the
page, share an invite link, and manage the rooms they own: copy or revoke
links, remove people, and delete the room. Someone who opens a link signs in,
sees who invited them to which room, and joins. Rooms in `CANVAS_ROOMS` keep
working as before beside them, managed by the seed.

The rooms service does this. It holds the Felix admin credential, which it
gets from the `tokens` provider as the seed does, so keep it on the internal
network like the control plane; the page reaches it only at `/api/` on the
canvas's own origin. [design.md](design.md#self-service-rooms) explains how it
works.

In the compose install, add `rooms.yaml` and set an invite secret in `.env`:

```bash
echo "CANVAS_INVITE_SECRET=$(openssl rand -hex 24)" >> .env
docker compose -f docker-compose.yml -f rooms.yaml up -d
```

`rooms.yaml` adds the `rooms` service and an `edge` (Caddy, with
`Caddyfile` beside it) that takes over `CANVAS_PORT` from the gateway and sends
`/api/` to the rooms service and everything else to the gateway. It needs
Compose 2.24.4 or later. Changing `CANVAS_INVITE_SECRET` stops every open
invite link.

Anyone your provider signs in can create rooms, so limit who that is at the
provider, and set the limits below to what your deployment can hold. Each room
costs what an operator room does: two streams and three caches, with a segment
each on disk (see `FELIX_SEGMENT_BYTES`).

A removed person cannot join the room again, but a session they already have
open keeps working until its Felix token refreshes, which is
`FELIX_TOKEN_TTL_SECONDS` (see [Felix gaps](#felix-gaps-this-works-around)).
Deleting a room ends every session in it.

## TLS

**Browsers to the canvas.** Serve the canvas over HTTPS anywhere but
`localhost`: the sign-in uses the browser's Web Crypto API, which only works
on secure origins. Put a reverse proxy in front of the gateway. With
[Caddy](https://caddyserver.com), which gets a certificate on its own, add a
`tls.yaml` next to the compose file:

```yaml
services:
  proxy:
    image: docker.io/library/caddy:2
    command: caddy reverse-proxy --from canvas.example.com --to gateway:8787
    ports: ["80:80", "443:443"]
    volumes: [caddy-data:/data]
    restart: unless-stopped
volumes:
  caddy-data:
```

and start with `-f docker-compose.yml -f tls.yaml`. The proxy must pass
WebSocket upgrades on `/ws`, which Caddy does by default. Register
`https://canvas.example.com/` as the redirect URI. With `rooms.yaml` as well,
proxy to `edge:8787` instead of `gateway:8787`, so `/api/` reaches the rooms
service.

**The gateway and snapshotter to the broker.** QUIC is always TLS. On first
start the `certs` service writes a self-signed certificate for the name
`broker` to the `state` volume, and both trust exactly that certificate. To use
your own, put `broker.crt` and `broker.key` (PEM) in the volume before the
first start; the certificate must name `broker`, and its issuer must be in the
certificate file you give the gateway and snapshotter.

**The control plane** is plain HTTP on the compose network, which nothing
outside reaches, and so is its Raft peer listener, which also requires the
peer token. So is the `tokens` provider, which is why
`FELIX_CONTROLPLANE_OIDC_ALLOW_INSECURE_HTTP` is on.

## Backups

Two volumes hold everything, and they belong together:

| Volume | What | Lose it and |
|---|---|---|
| `controlplane-data` | The control plane's Raft log and snapshots: the tenant, rooms, roles and trusted issuers | Felix no longer knows the rooms in its log |
| `felix-data` | Every room's op log, snapshots, member list and sequence counters | Every drawing is gone |
| `state` | The service tokens and the broker certificate | Nothing: the seed re-mints the tokens and `certs` makes a new certificate |

Back them up together, with Felix stopped so neither is mid-write. The
control plane is a Raft group of one, so a copy of its volume taken while it
is stopped is the whole of its state:

```bash
docker compose stop gateway snapshotter broker controlplane
docker run --rm -v "$PWD":/out \
  -v felix-canvas_controlplane-data:/backup/controlplane -v felix-canvas_felix-data:/backup/broker \
  docker.io/library/debian:trixie-slim tar czf /out/felix-backup.tar.gz -C /backup controlplane broker
docker compose up -d
```

To restore, start from empty volumes, untar both, and start everything:

```bash
docker compose down -v
docker run --rm -v "$PWD":/out \
  -v felix-canvas_controlplane-data:/backup/controlplane -v felix-canvas_felix-data:/backup/broker \
  docker.io/library/debian:trixie-slim tar xzf /out/felix-backup.tar.gz -C /backup
docker compose up -d
```

The backup holds every tenant's token signing keys, so keep it as you would a
password.

A log restored without its metadata, or the other way round, does not match:
the broker would hold records for streams the control plane does not know.

## Upgrading

Each release pins its canvas images and the Felix version it was tested with
in `docker-compose.yml`. To upgrade, back up, replace `docker-compose.yml`
with the one in the new release's compose bundle, keep your `.env`, and
restart:

```bash
docker compose pull
docker compose up -d
```

Read the release notes first for settings that were added or renamed, and
Felix's own release notes when `FELIX_VERSION` changes. Keep the backup until
the new release has run for a while: restoring it with the old compose file is
the way back.

The broker and snapshotter read their tokens once, when they start
([felix#955](https://github.com/GetFelix/felix/issues/955)), and the tokens last
`FELIX_TOKEN_TTL_SECONDS`, 30 days by default. Restart at least that often,
which also re-mints them:

```bash
docker compose up -d --force-recreate
```

## Kubernetes

`deploy/helm/felix-canvas` runs the canvas next to a release of the
[felix chart](https://github.com/GetFelix/felix/tree/main/deploy/helm/felix):
the gateway scaled horizontally, one snapshotter, and the seed as a Job. The
[chart's README](../deploy/helm/felix-canvas/README.md) lists what it renders.

The brokers need a credential, the seed mints it, and the seed needs the
control plane, so the two charts go in this order. CI runs exactly this on
kind, with the values in `deploy/helm/felix-canvas/ci/`.

1. Three Secrets: the control plane's bootstrap token, its Raft peer token,
   and the brokers' client certificate, which must name what the canvas dials
   (`felix-broker` here):

   ```bash
   kubectl create secret generic felix-bootstrap --from-literal=token="$(openssl rand -hex 24)"
   kubectl create secret generic felix-raft-peer --from-literal=token="$(openssl rand -hex 24)"
   kubectl create secret tls felix-broker-tls --cert=broker.crt --key=broker.key
   ```

2. The felix chart with its brokers off. `ci/felix-values.yaml` is a starting
   point: a three-member Raft control plane, which keeps the metadata in its
   own volumes so no database is needed, the broker settings the canvas wants
   (acks with offsets, small delivery batches, a deep writer queue, 16 MiB segments), each broker
   advertised by pod IP, and the control plane's token lifetime and accepted
   algorithms as in the compose install. Add brokers and peer mTLS as the
   felix chart's README describes.

   ```bash
   git clone --depth 1 --branch v0.6.0-preview.5 https://github.com/GetFelix/felix
   helm install felix felix/deploy/helm/felix -f felix-values.yaml
   ```

3. This chart, from the release, with your provider and rooms. Its seed Job
   stores the broker credential in the Secret `felix-canvas-broker-credential`.
   Each release also attaches the chart as `felix-canvas-0.3.1.tgz`, which
   `helm install` takes in place of the `oci://` reference:

   ```bash
   helm install felix-canvas oci://ghcr.io/getfelix/charts/felix-canvas --version 0.3.1 -f canvas-values.yaml
   kubectl wait --for=condition=complete job -l app.kubernetes.io/component=seed
   ```

   where `canvas-values.yaml` sets at least:

   ```yaml
   felix:
     controlPlaneUrl: http://felix-controlplane:8443
     brokers: [felix-broker:5000]
     serverName: felix-broker
     caSecret: { name: felix-broker-tls, key: tls.crt }
   seed:
     bootstrapUrl: http://felix-controlplane-bootstrap:9095
     bootstrapSecret: { name: felix-bootstrap }
   oidc:
     issuer: https://login.example.com/realms/canvas
     clientId: felix-canvas
   rooms: lobby=ana@example.com,ben@example.com
   gateway:
     ingress:
       enabled: true
       host: canvas.example.com
       tlsSecret: canvas-example-com-tls
   ```

4. The brokers:

   ```bash
   helm upgrade felix felix/deploy/helm/felix -f felix-values.yaml --set broker.enabled=true
   ```

With three or more brokers, set `felix.replicas: 3` before the first install,
so every room is copied to three brokers and survives losing one.

The snapshotter waits for its token on a first install and for the brokers
after that, so it restarts a few times before it settles.

`selfService.enabled: true` runs the rooms service as one more Deployment,
makes a Secret `<release>-invite-key` with the invite secret on first install
and keeps it, and adds `/api` to the gateway's ingress, routed to the rooms
service. Without the chart's ingress, route `/api` on the canvas's host to the
Service `<release>-rooms` port 8789 yourself. `selfService.inviteSecret` names
a Secret of your own instead, and `selfService.roomsPerUser`,
`membersPerRoom`, `invitesPerRoom` and `inviteTtlHours` set the limits.

`gateway.scope` replaces the image's scope file with the TOML you give it,
for instance a different member TTL: `--set-file gateway.scope=scope.toml`.

Each `helm upgrade` of this chart runs the seed again, which adds new rooms and
members and re-mints both tokens. The broker and the snapshotter read theirs
only at start ([felix#955](https://github.com/GetFelix/felix/issues/955)), so
restart both within the token lifetime:

```bash
kubectl rollout restart statefulset/felix-broker deployment/felix-canvas-snapshotter
```

Back up the control plane's Raft volumes and the brokers' volumes together,
for the same reason as in the compose install, with the control plane and the
brokers scaled to zero so nothing is mid-write.

## Configuration reference

### Compose (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `FELIX_BOOTSTRAP_TOKEN` | required | The control plane's day-0 token. The seed uses it to create the tenant |
| `FELIX_RAFT_PEER_TOKEN` | required | The control plane's Raft peer token, 32 characters or more. Whoever holds it can replace the metadata |
| `CANVAS_BIND` | `127.0.0.1` | The host address the canvas listens on. `0.0.0.0` for every interface |
| `CANVAS_PORT` | `8787` | The host port the canvas listens on |
| `COMPOSE_PROFILES` | `dev-idp` | `dev-idp` runs the development sign-in page. Empty once you use your own provider |
| `CANVAS_DEV_USERS` | `ana,ben` | The names the development sign-in page offers |
| `CANVAS_OIDC_*`, `CANVAS_ROOMS` | the development page | As for the gateway and the seed below |
| `CANVAS_INVITE_SECRET` | empty | With `rooms.yaml`, required: as for the rooms service below |
| `CANVAS_ROOMS_PER_USER`, `CANVAS_MEMBERS_PER_ROOM`, `CANVAS_INVITES_PER_ROOM`, `CANVAS_INVITE_TTL_HOURS` | `5`, `20`, `10`, `168` | With `rooms.yaml`: as for the rooms service below |
| `CANVAS_TENANT`, `CANVAS_NAMESPACE` | `canvas`, `default` | Where the rooms live in Felix |
| `CANVAS_VERSION` | the release | The canvas images' tag |
| `FELIX_VERSION` | the release's Felix | The Felix images' tag |
| `FELIX_OIDC_ALGORITHMS` | `ES256,RS256` | ID token signing algorithms Felix accepts |
| `FELIX_SEGMENT_BYTES` | `16777216` | The broker's log segment size. Each log a room writes to reserves a whole segment on disk up front, so this sets what a room costs before anyone draws. Felix's own default is 256 MiB |
| `FELIX_TOKEN_TTL_SECONDS` | `2592000` | How long a token from the control plane lasts, browser sessions' included. Sessions refresh theirs; the broker's and snapshotter's last until a restart |
| `FELIX_LOG`, `CANVAS_LOG` | `info` | Log filters for Felix and the gateway |

### Gateway

The gateway is felix-gateway, which reads `GATEWAY_*` variables. Its
[configuration reference](https://github.com/GetFelix/felix-gateway/blob/v0.3.2/docs/configuration.md)
lists them all. The canvas image sets these:

| Variable | In the image | Meaning |
|---|---|---|
| `GATEWAY_LISTEN` | `0.0.0.0:8787` | Where browsers connect |
| `GATEWAY_WEB_DIR` | `/usr/share/felix-canvas/web` | The built web page, served on every other path |
| `GATEWAY_SCOPE_FILE` | `/etc/felix-gateway/scope.toml` | The scope file: the room's streams, caches and counters, and what a session may do with each. The member TTL is the `members` cache's `ttl_s`, 30 seconds |
| `GATEWAY_TENANT` | `canvas` | The Felix tenant |
| `GATEWAY_OIDC_CLIENT_ID` | `felix-canvas` | The client registered for the canvas at the identity provider |

The compose file and the chart set the rest from the canvas's settings:
`GATEWAY_FELIX_BROKERS`, `GATEWAY_FELIX_SERVER_NAME`, `GATEWAY_FELIX_CA_FILE`,
`GATEWAY_FELIX_CONTROL_PLANE`, `GATEWAY_NAMESPACE` and `GATEWAY_OIDC_*`. The
gateway has no token of its own: each browser session gets one from the
control plane when it joins.

### Snapshotter

It reads `CANVAS_FELIX_BROKERS`, `CANVAS_FELIX_SERVER_NAME`,
`CANVAS_FELIX_CA_FILE`, `CANVAS_TENANT` and `CANVAS_NAMESPACE`, which mean what
the gateway's `GATEWAY_*` variables of the same names do, and:

| Variable | Default | Meaning |
|---|---|---|
| `CANVAS_FELIX_TOKEN` | required, or the file | Its own Felix token |
| `CANVAS_FELIX_TOKEN_FILE` | unset | A file holding that token, read at start |
| `CANVAS_ROOMS` | `lobby` | The rooms to snapshot, in the seed's format; only the names before `=` are read. Rooms people created are found in the `canvas.rooms` cache as they are made and deleted |
| `CANVAS_SNAPSHOTTER_LISTEN` | `127.0.0.1:8788` (`0.0.0.0:8788` in the image) | Where it answers `GET /` with each room's `{"applied", "saved"}`: the last offset folded and the last one a stored snapshot holds |
| `CANVAS_SNAPSHOT_EVERY_OPS` | `500` | Write a room's snapshot once this many records are folded but not saved |
| `CANVAS_SNAPSHOT_EVERY_MS` | `30000` | Or once the oldest of them has waited this long |
| `CANVAS_SNAPSHOTTER_CLAIM_WAIT_MS` | `30000` | How long it waits after starting before it reads, so records an earlier run claimed come back first. Match the broker's `FELIX_GROUP_VISIBILITY_TIMEOUT_MS` |

One snapshotter runs per deployment. Two would split each room's records
between them and write wrong snapshots.

### Rooms service

`node snapshotter/dist/rooms-main.js` in the snapshotter image. It reads
`CANVAS_FELIX_BROKERS`, `CANVAS_FELIX_SERVER_NAME`, `CANVAS_FELIX_CA_FILE`,
`CANVAS_TENANT` and `CANVAS_NAMESPACE` as the snapshotter does,
`CANVAS_FELIX_CONTROL_PLANE`, `CANVAS_SERVICE_IDP`, `CANVAS_REPLICAS` and the
`CANVAS_OIDC_*` settings as the seed does, and:

| Variable | Default | Meaning |
|---|---|---|
| `CANVAS_INVITE_SECRET` | required, or the file | The key invite links are signed with, 16 characters or more |
| `CANVAS_INVITE_SECRET_FILE` | unset | A file holding that key, read at start |
| `CANVAS_ROOMS_LISTEN` | `127.0.0.1:8789` | Where it serves `/api/`. `GET /api/health` answers without a sign-in |
| `CANVAS_ROOMS_PER_USER` | `5` | Rooms one person may own at once |
| `CANVAS_MEMBERS_PER_ROOM` | `20` | People in one room, its owner included |
| `CANVAS_INVITES_PER_ROOM` | `10` | Invite links one room may have open at once |
| `CANVAS_INVITE_TTL_HOURS` | `168` | How long an invite link works |

One rooms service runs per deployment. It is the only writer of the room list,
so two would overwrite each other's changes.

### Seed

`node dev/seed.mjs` in the snapshotter image. Safe to run again.

| Variable | Default | Meaning |
|---|---|---|
| `CANVAS_FELIX_CONTROL_PLANE` | `http://controlplane:8443` | The control plane's API |
| `CANVAS_FELIX_BOOTSTRAP` | `http://controlplane:9095` | The control plane's bootstrap listener |
| `CANVAS_FELIX_BOOTSTRAP_TOKEN` | `dev-bootstrap` | Its token |
| `CANVAS_SERVICE_IDP` | `http://idp:9400` | A `dev/idp.mjs` the service accounts sign in with. Keep it unreachable from outside |
| `CANVAS_STATE_DIR` | `/state` | Where it writes `node.token` and `snapshotter.token` |
| `CANVAS_TENANT`, `CANVAS_NAMESPACE` | `canvas`, `default` | Where to create the rooms |
| `CANVAS_ROOMS` | `lobby=ana,ben,cleo studio=ana` | Rooms and their members, `room=member,member` separated by spaces |
| `CANVAS_OIDC_ISSUER` | the service provider's | The browsers' provider |
| `CANVAS_OIDC_JWKS_URL` | from the issuer's discovery document | Where Felix fetches that provider's keys |
| `CANVAS_OIDC_CLIENT_ID` | `felix-canvas` | The client ID, used as the audience unless the next one is set |
| `CANVAS_OIDC_AUDIENCE` | the client ID | The audience browsers' ID tokens carry |
| `CANVAS_OIDC_SUBJECT_CLAIM` | `sub` | The claim that names a member |
| `CANVAS_OIDC_GROUPS_CLAIM` | unset | The claim holding a member's groups, for `group:` members |
| `CANVAS_REPLICAS` | `1` | Copies of each room's streams and caches. Above 1, the op log and caches acknowledge on a majority, so a room survives losing a broker; needs that many brokers |

## Felix gaps this works around

| What | Why | Felix issue |
|---|---|---|
| The `tokens` service | Felix issues tokens only in exchange for an IdP token, so the service accounts need a provider of their own | [#954](https://github.com/GetFelix/felix/issues/954) |
| `FELIX_TOKEN_TTL_SECONDS` of 30 days and a restart within it | A standalone broker reads its token once and stops working when it expires | [#955](https://github.com/GetFelix/felix/issues/955) |
| `FELIX_ACK_ON_COMMIT=true` on the broker | Only an ack after the write carries the record's offset, and that is a broker-wide setting | [#956](https://github.com/GetFelix/felix/issues/956) |
| `FELIX_SUB_QUEUE_BOUND=8192` on the broker | The writer queue is per connection, with one entry per subscription for each change, so the default of 64 loses changes on a busy connection | Not filed yet |
| Removing someone from a room ends their open session only at its next token refresh | Felix cannot revoke a token it issued, and browser sessions share `FELIX_TOKEN_TTL_SECONDS` with the broker's credential | Not filed yet |
| The compose file is written from Felix's environment reference | Felix's own compose docs still pin 0.5.0 | [#957](https://github.com/GetFelix/felix/issues/957) |
