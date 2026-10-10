# Development

How to work on Felix Canvas: where to run it, how to run it locally, how the
repository is laid out, the rules the lockfile follows, and what CI checks.

## Where to run it

Everything runs on one machine: Docker for Felix, Rust to install the gateway,
and Node for `model/`, `web/` and the snapshotter.

| Environment | When | Notes |
|---|---|---|
| Your machine | Docker and npmjs.org are both available | Follow [Running locally](#running-locally). |
| GitHub Codespace | npmjs.org is blocked, or you don't want Docker locally | The default image has Node and Docker. Install Rust 1.97 or later with rustup. Use the 4-core machine: the Felix images, the gateway install and Playwright run side by side. |
| CI | Every push and pull request | The same checks as below, against the published Felix images. |

A Codespace can be driven from another machine. Write an ssh config once, then
sync edits with rsync and run commands over `gh`:

```bash
gh codespace ssh -c <name> --config > ~/.ssh/codespaces
rsync -az --exclude .git --exclude node_modules --exclude target \
  -e "ssh -F $HOME/.ssh/codespaces" ./ cs.<name>.main:/workspaces/felix-canvas/
gh codespace ssh -c <name> -- 'cd /workspaces/felix-canvas && npm test'
```

Delete the Codespace when the work is merged.

## Running locally

You need Docker or Podman, Rust 1.97 or later, and Node 24. The gateway is
[felix-gateway](https://github.com/GetFelix/felix-gateway) 0.3.1; install it
once:

```bash
cargo install --locked felix-gateway --version 0.3.1
```

1. Start Felix. This pulls `ghcr.io/getfelix/felix-broker` and
   `felix-controlplane` at `0.6.0-preview.5`, starts a stand-in sign-in service on
   `127.0.0.1:9400`, creates the `lobby` and `studio` rooms, and writes the
   snapshotter's token and the broker's certificate to `dev/state/`:

   ```bash
   dev/up.sh
   ```

   Each run starts from an empty log. `docker compose -f dev/docker-compose.yml down -v`
   stops it. `dev/up.sh` uses Docker when its daemon is running and Podman
   otherwise (`podman machine start` first on macOS); set
   `CONTAINER_ENGINE=podman` to choose, and use `podman compose` for the
   commands here.

2. Start the gateway, which listens on `127.0.0.1:8787`. It has no token of its
   own; each browser's sign-in is exchanged for one when it joins:

   ```bash
   export GATEWAY_FELIX_CA_FILE=dev/state/broker-cert.pem
   export GATEWAY_SCOPE_FILE=deploy/scope.toml
   export GATEWAY_TENANT=canvas GATEWAY_OIDC_CLIENT_ID=felix-canvas
   felix-gateway
   ```

3. In another shell, build the shared model and start the snapshotter, which
   answers on `127.0.0.1:8788` with how far it has got:

   ```bash
   npm install
   npm run build -w @felix-canvas/model -w @felix-canvas/snapshotter
   export CANVAS_FELIX_TOKEN="$(cat dev/state/snapshotter.token)"
   export CANVAS_FELIX_CA_FILE="$PWD/dev/state/broker-cert.pem"
   npm start -w @felix-canvas/snapshotter
   ```

4. To make rooms from the page, start the rooms service in another shell. It
   signs in as the seed's admin account through the stand-in provider and
   answers `/api/` on `127.0.0.1:8789`:

   ```bash
   export CANVAS_FELIX_CA_FILE="$PWD/dev/state/broker-cert.pem"
   export CANVAS_FELIX_CONTROL_PLANE=http://127.0.0.1:8443 CANVAS_SERVICE_IDP=http://127.0.0.1:9400
   export CANVAS_INVITE_SECRET="$(openssl rand -hex 24)"
   npm run rooms -w @felix-canvas/snapshotter
   ```

   Without it the page keeps to the seed's rooms.

5. In another shell, start the page, which proxies the gateway's routes and
   the rooms service's `/api/`:

   ```bash
   npm run dev -w @felix-canvas/web
   ```

6. Open <http://localhost:5173> in two windows, continue as `ana` or `ben`, and
   draw: <kbd>R</kbd> for a rectangle, <kbd>O</kbd> an ellipse, <kbd>L</kbd> a
   line, <kbd>P</kbd> the pen, <kbd>T</kbd> text, <kbd>V</kbd> to select and
   drag, and <kbd>?</kbd> for every shortcut. Double-click a shape to type in
   it; type in the same box from both windows at once. The chip at the top right shows how long your changes
   take to save; click it for the sync details, including the canvas version
   both windows should share. `?room=studio` opens the other room, which only
   `ana` may open. With the rooms service running, click the room name to
   make a room, and Share in it to invite the other window.

`curl -s 127.0.0.1:8787/metrics` shows the latency of both legs.

The browser tests start their own gateway (`felix-gateway` on your `PATH`, or
`CANVAS_GATEWAY_BIN`), snapshotter, rooms service and page against the
running stack:

```bash
npx -w @felix-canvas/web playwright install chromium
npm run test:e2e -w @felix-canvas/web
```

[self-hosting.md](self-hosting.md#configuration-reference) lists every
variable the snapshotter and the seed read, and what the canvas sets for the
gateway.

## Repository layout

| Path | What |
|---|---|
| `model/` | The op schema, its MessagePack encoding, the fold, the snapshot format and the state hash, shared by the browser and the snapshotter |
| `snapshotter/` | Two Node services on the `felix-client` npm package: the snapshotter, which reads each room's log through a consumer group and keeps its snapshot in the cache, and the rooms service (`src/rooms/`), which creates rooms and invites for signed-in people |
| `web/` | The browser client: Canvas2D renderer, tools, the op pipeline and join path, and the Playwright tests |
| `dev/` | Felix for local runs and CI: Docker Compose over the published images with one broker or three, a stand-in IdP, and the seed script |
| `docker/` | The Dockerfiles for the two images. The canvas image is the published `ghcr.io/getfelix/felix-gateway` image plus the web page and `deploy/scope.toml` |
| `deploy/compose/` | The release compose file, its settings, and a Dex example |
| `deploy/helm/felix-canvas/` | The Helm chart, run next to the Felix chart |
| `docs/design.md` | The design: data model, editing and join rules, failure modes, targets |
| `docs/protocol.md` | How the canvas uses the gateway: its scope file, join and history order, and payload formats |
| `docs/ux.md` | The UX and visual design brief the interface is built from |
| `docs/development.md` | Running it locally, the repository layout, the lockfile rule, the dev stack and CI |
| `docs/self-hosting.md` | Installing, your own IdP, TLS, backups, upgrades, and every setting |
| `docs/performance.md` | Measured results for each performance target |
| `docs/brand/` | The Felix Canvas mark, adapted from the Felix logo |
| `CONTRIBUTING.md` | How code, comments and pull requests should read |

## npm registry and the lockfile

`.npmrc` pins `registry=https://registry.npmjs.org/`, and the project file wins
over a user-level `~/.npmrc`. Don't install through a mirror. A corporate mirror
can rewrite `package-lock.json` to resolve from private feeds that CI can't reach,
and can downgrade integrity hashes from sha512 to sha1.

CI fails if any lockfile entry resolves from anywhere but npmjs.org or lacks a
sha512 hash. Generate lockfile changes on a machine that reaches npmjs.org, or in
a Codespace.

## The Felix dev stack

`dev/up.sh` starts the broker and control plane from
`ghcr.io/getfelix/felix-broker` and `felix-controlplane` at the version pinned in
`dev/docker-compose.yml`, along with `dev/idp.mjs`, a stand-in OpenID Connect
provider on `127.0.0.1:9400`. Its sign-in page signs in anyone who picks a name,
and the canvas shows that name capitalised: `ana` appears as Ana.
The seed then creates two rooms and decides who may open them:

| Room | Members |
|---|---|
| `lobby` | `ana`, `ben`, `cleo` |
| `studio` | `ana` |

For each room it creates the two streams, the single-shard
`canvas.seq.<room>`, `canvas.snap.<room>` and `canvas.members.<room>` caches (a
cache watch reads one shard, and the member list is one), and the role
`role:room-<room>`, assigned to the members. It also creates `canvas.rooms`,
the single-shard cache the rooms service keeps the rooms people make in, and
lets the admin account read and write it. It writes the broker's credential,
the snapshotter's token and the broker's certificate to `dev/state/`. Every run
starts from an empty log. Open <http://localhost:5173/?room=studio> as `ben` to
see a refused room.

The snapshotter and the seed read the variables in the
[configuration reference](self-hosting.md#configuration-reference), and the
gateway reads `GATEWAY_*` ones. Their defaults match this stack, so a local run
needs only the broker's certificate and the snapshotter's token from
`dev/state/`, and the gateway the canvas's scope file, tenant and client ID, as
in step 2 above.

The scope file names the room's streams and caches; the seed creates the same
ones, so a change to one is a change to both. The Playwright config starts the
gateway with a copy that has a 6 second member TTL.

Four settings there exist only because of Felix gaps:

| Setting | Why | Felix issue |
|---|---|---|
| `GET /token?sub=` on `dev/idp.mjs` | The seed and the tests need tokens without a browser, and Felix issues them only in exchange for an IdP token | [#954](https://github.com/GetFelix/felix/issues/954) |
| `FELIX_EXCHANGE_TOKEN_TTL_SECONDS=86400` | A standalone broker reads its node token once, so the default 900 s would end a dev session after 15 minutes | [#955](https://github.com/GetFelix/felix/issues/955) |
| `FELIX_ACK_ON_COMMIT=true` | Only an ack after the write carries the record's offset, and that is a broker-wide setting | [#956](https://github.com/GetFelix/felix/issues/956) |
| `FELIX_SUB_QUEUE_BOUND=8192` | The broker's writer queue is per connection and holds one entry per subscription per change, so at the default of 64 a client holding 100 subscriptions on one connection loses changes even at 50 a second, and no metric counts the loss | Not filed yet |

### Three brokers

`dev/up.sh --cluster` lays `dev/docker-compose.cluster.yml` over the same stack
and starts three brokers instead of one. The seed then gives every stream and
cache three replicas, and the op log and caches `Quorum` consistency, so a
change is acknowledged only once two of the three brokers hold it. The control
plane runs with short liveness windows (a 500 ms heartbeat and a 3 second
expiry), so a stopped broker's rooms move within a few seconds rather than the
default of about twenty.

The control plane places a shard on whichever brokers are live when the shard
is created. If one broker reports in before the others, a shard can start on
fewer copies than it asks for, and one placed on its leader alone never gets
the rest ([GetFelix/felix#1151](https://github.com/GetFelix/felix/issues/1151),
[#1153](https://github.com/GetFelix/felix/issues/1153)). So in the cluster the
seed writes the brokers' token first, waits until all three are live
(`CANVAS_WAIT_FOR_BROKERS`), and only then creates the rooms. `up.sh --cluster`
also waits until `GET /v1/placement/replication` lists no shard short of its
copies or still being given one: a broker's `/ready` doesn't say that.

| Broker | Client port (UDP) | Health |
|---|---|---|
| `broker` (node `broker-1`) | `127.0.0.1:5000` | `127.0.0.1:8080` |
| `broker-2` | `127.0.0.1:5010` | `127.0.0.1:8081` |
| `broker-3` | `127.0.0.1:5020` | `127.0.0.1:8082` |

Each broker signs its own certificate, and `up.sh` concatenates the three into
`dev/state/broker-cert.pem`. Give the gateway and the snapshotter every broker
(the Playwright config passes `CANVAS_FELIX_BROKERS` on to the gateway):

```bash
dev/up.sh --cluster
export CANVAS_FELIX_CA_FILE=dev/state/broker-cert.pem GATEWAY_FELIX_CA_FILE=dev/state/broker-cert.pem
export CANVAS_FELIX_BROKERS=127.0.0.1:5000,127.0.0.1:5010,127.0.0.1:5020
export GATEWAY_FELIX_BROKERS=$CANVAS_FELIX_BROKERS
```

`GET /v1/placement/replication` on the control plane, with the broker's token
from `dev/state/node.token`, names the broker that owns each room's op log.
The failover test reads it there, checks the same list shows every shard
fully copied, kills that broker's container with
`docker kill` (or `podman kill`, picked the same way as `dev/up.sh`), and
starts it again at the end:

```bash
CANVAS_FELIX_CLUSTER=1 npm run test:e2e -w @felix-canvas/web -- failover
```

The brokers trust each other without certificates
(`FELIX_INTERNAL_ALLOW_UNAUTHENTICATED`), which is fine on a compose network
only the brokers share and nowhere else.

## Images and the compose install

`docker/gateway.Dockerfile` and `docker/snapshotter.Dockerfile` build from the
repository root:

```bash
docker build -f docker/gateway.Dockerfile -t ghcr.io/getfelix/felix-canvas:dev .
docker build -f docker/snapshotter.Dockerfile -t ghcr.io/getfelix/felix-canvas-snapshotter:dev .
CANVAS_VERSION=dev docker compose -f deploy/compose/docker-compose.yml up -d
```

With Podman, `podman build` and `podman compose` take the same arguments.

The gateway image is `ghcr.io/getfelix/felix-gateway` with the built page in
`GATEWAY_WEB_DIR` and the canvas's scope file, so the install needs no separate
web server. The snapshotter image also carries
`dev/seed.mjs` and `dev/idp.mjs`, which the compose file runs from it.

`CANVAS_E2E_URL` points the Playwright tests at an install that is already
running instead of starting their own servers, and `CANVAS_E2E_PASSWORD` makes
them sign in through a Dex login form. Only `convergence.e2e.ts` is meant for
an install; the others drive the dev stack directly.

[Releasing](#releasing) covers tagging and what a release publishes.

`deploy/helm/felix-canvas/ci/kind-install.sh` installs the Felix chart and
this one on a kind cluster, given `FELIX_CHART` and the two images loaded as
`:ci`.

## What CI checks

| Job | Checks |
|---|---|
| Gateway against Felix | Starts the dev stack and the pinned felix-gateway with `deploy/scope.toml`, and joins rooms as members and as someone who is not one. The gateway's own tests, including the narrowing test at the broker, run in felix-gateway's CI |
| TypeScript | The lockfile rule above, `npm ci`, prettier, the build, type checks and unit tests for `model/`, `web/` and `snapshotter/` |
| Two browsers against Felix | Starts the dev stack, the gateway, the snapshotter and the page, and runs the Playwright tests in `web/e2e/`: two browsers converging, a cold browser joining a 10,000-op room, two people seeing each other's cursors and member list, a person who is not a member being shown that they cannot open a room, a throttled browser catching up while the others' save time holds, a browser scrubbing a 10,000-change room in the studio, checking each stop against a fresh fold, within a time bound, two people typing into one text box at once and ending with the same text, the canvas breaking a fixed set of bodies into the same lines as the editor, every control and shortcut of the text bar in both themes, pasted HTML keeping only the formats text can have, carets staying on their characters while others type, an open editor keeping its caret and unsent typing through a rejoin from the snapshot, and someone making a room, inviting a second person who joins through the link, removing them, and deleting the room. The history, cold-join and slow-connection tests have typing in their load. Each browser signs in through the stand-in provider's page. They run one at a time because they share a room, and the gateway runs with a 6 second member TTL so the crashed-tab test stays short |
| Failover against a Felix cluster | Starts the three-broker stack and runs `web/e2e/failover.e2e.ts`: two browsers edit while a third watches the room's history, the broker that owns the room's op log is killed, and both editors end with the same state hash, which is also the fold of the log read back from offset 0. Every edit a browser saw acknowledged is in that log, the history view reaches the same state, the snapshotter carries on, and a browser that joins afterwards matches. It is a separate job, and not a required check, because it needs three brokers and stops one |
| Release (workflow) | On pull requests, a dry run of the release: the tree's versions agree, the `CHANGELOG.md` section for that version exists, and the chart and the compose bundle package. See [Releasing](#releasing) |
| Images (workflow) | Builds both images on amd64 and arm64 runners, then starts the release compose file from the amd64 builds and runs the two-browser test in it, once with the development sign-in page, once with Dex, and once with `rooms.yaml`, where it also runs the self-service rooms test. Every run also checks that each image's publish step would find exactly its own two platform digests. When the Release workflow calls it with a tag, it pushes, merges and signs the images first, skipping any already published, and runs the install from GHCR. On pull requests it also installs the Felix chart and this chart on kind, with self-service rooms on, and runs the same test through it |

## Releasing

A release is a `v*` tag on `main`, such as `v0.2.0`, or `v0.2.0-rc.1` for a
pre-release. To cut one:

1. In one pull request, set the new version everywhere the release workflow
   checks: the `package.json` of `model/`, `web/` and `snapshotter/` and
   `package-lock.json` (run `npm install`), the chart's `version` and `appVersion` in
   `deploy/helm/felix-canvas/Chart.yaml`, every `CANVAS_VERSION` default in
   `deploy/compose/docker-compose.yml`, and the image tags and release links in
   the docs. Rename `## [Unreleased]` in `CHANGELOG.md` to
   `## [0.2.0] - <date>` and add an empty `## [Unreleased]` above it.
2. Before merging, run the Release workflow from the branch with that tag and
   `dry_run` checked. It runs every check and builds every asset, and
   publishes nothing.
3. Merge, then tag the merge commit and push the tag:

   ```bash
   git tag -a v0.2.0 -m v0.2.0 && git push origin v0.2.0
   ```

The tag starts the Release workflow. It checks that the tag matches every
version in the tree, runs the Images workflow to build, push and sign both
images and run the compose install from them, packages the chart and pushes it to `oci://ghcr.io/getfelix/charts/felix-canvas`
signed with cosign, bundles `deploy/compose/` as
`felix-canvas-compose-<version>.tar.gz`, and creates the GitHub release. Its
notes are the version's `CHANGELOG.md` section, an install block and the image
digests, and its assets are the chart, the compose bundle and `SHA256SUMS`. A
version with a `-` suffix is marked as a pre-release.

To release a tag that already exists, or finish a release that failed part
way, run the Release workflow by hand from `main` with the tag as `tag`. An
image or chart already published and signed for that version is kept rather
than built and pushed again. The notes and the release scripts come from the
branch the workflow runs from, so a changelog entry fixed on `main` is used.
Every pull request also runs it as a dry run against the version in the tree.

## Measuring the performance targets

Two Playwright specs measure rather than check, so they skip unless asked.
The fanout spec needs felix-gateway's `viewers` example, built from a checkout
of its `v0.3.1` tag:

```bash
git clone --branch v0.3.1 https://github.com/GetFelix/felix-gateway ../felix-gateway
cargo build --release --manifest-path ../felix-gateway/Cargo.toml -p felix-gateway --example viewers
export CANVAS_VIEWERS_BIN=$PWD/../felix-gateway/target/release/examples/viewers

dev/up.sh

# Local echo, edit, typing and cursor visibility, snapshot lag and cold joins.
CANVAS_MEASURE=1 npm run test:e2e -w @felix-canvas/web -- targets

# Publish latency with 1 viewer and with 500.
CANVAS_FANOUT_VIEWERS=500 npm run test:e2e -w @felix-canvas/web -- fanout
```

Each prints a row per target and fails if a target is missed.
[performance.md](performance.md) records the numbers and the machine they came
from.

| Target | How it is timed |
|---|---|
| Local echo | From the input event reaching the page to the end of drawing the frame that shows its effect |
| Edit visible to another client | From the edit being made (the `at` time stamp in its op) to the end of drawing the frame that shows it in the other browser. Both browsers share one clock |
| Cursor visible to another client | A browser's own presence message, from publish to its delivery back, which is the path every other viewer's copy takes |
| Join a 10,000-change room | From starting to join until the first frame drawn from the snapshot plus the changes after it |
| Keystroke to own character | From the key event reaching the editor to the animation frame after ProseMirror applied it |
| Typed text visible to another client | From the first keystroke a text op carries (its `at`) to the end of drawing the frame that shows it in the other browser, so it includes the 150 ms the editor waits to send |
| Text ops per typing person | The author's text ops in the log over a 30-second run at ten keys a second |
| Snapshot lag | The newest change's offset minus the offset the stored snapshot holds, sampled while a writer adds 300 changes a second |
| Fanout | The editing browser's publish to Felix's acknowledgement, alternating 1 viewer and the full count three times |

The fanout viewers come from felix-gateway's `examples/viewers.rs`: one Felix client
holding a subscription per viewer to the room's op log, from the live tail,
each counting the changes it receives and any offsets skipped. It does the
same thing as `felix-loadgen --scenario pubsub --fanout N` on the subscriber
side. `felix-loadgen` itself cannot be used: its pubsub scenario always runs
its own publisher at full speed into the stream, so it measures a saturated
room rather than one person editing, and its subscribers stop once they have
counted the publisher's records.

The editing browser is one of the viewers, so the 1-viewer case starts no
extra subscriptions and the 500-viewer case starts 499. Every gateway session
has its own Felix client, because Felix ties a connection to one token
([felix#969](https://github.com/GetFelix/felix/issues/969)). The gateway opens
one publish, one subscription and one cache connection per session rather
than Felix's default 4, 8 and 8, which against the broker's limit of 512
connections per address would stop one gateway host at about 25 sessions.

## Milestones and issues

Work follows the build order in [design.md](design.md#build-order). Each milestone
is a [GitHub milestone](https://github.com/GetFelix/felix-canvas/milestones), each
piece of it is an issue, and each milestone lands as one pull request that closes
its issues. When Felix gets in the way, file an issue on
[Felix](https://github.com/GetFelix/felix/issues) and link it from the pull request.
