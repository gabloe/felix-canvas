# How the canvas talks to the gateway

The canvas runs [felix-gateway](https://github.com/GetFelix/felix-gateway)
0.3.1 between browsers and Felix. Its
[protocol](https://github.com/GetFelix/felix-gateway/blob/v0.3.1/docs/protocol.md)
and [configuration](https://github.com/GetFelix/felix-gateway/blob/v0.3.1/docs/configuration.md)
are documented there. This page covers what is specific to the canvas: its
scope file, the order it joins and reads history in, how it finds a loss, and
what its payloads hold.

## The scope file

`deploy/scope.toml` names the scope field `room` and gives each room these
resources:

| Alias | Kind | Felix name | Notes |
|---|---|---|---|
| `ops` | Stream | `canvas.ops.<room>` | Durable, kept until the broker's retention trims it. Every event has an offset |
| `presence` | Stream | `canvas.presence.<room>` | In memory, at most once. Offsets are always `null` |
| `snap` | Cache | `canvas.snap.<room>` | The snapshot, key `latest` |
| `members` | Cache | `canvas.members.<room>` | One key per session, each expiring unless its session writes it again |
| `seq` | Counter | `canvas.seq.<room>` | Per-session op sequence numbers |

Every room has its own streams and caches because Felix authorizes a cache as
a whole, never one key of it. The file also sets `allow_throttle`, for the
slow-link switch in the toolbar, and the gateway's write limits: its default
rates, 16 sessions per person, no per-address session cap, and ops of up to
256 KiB.
[self-hosting.md](self-hosting.md#rooms-and-members) says why.

## Joining

A browser joins a room in this order:

1. `subscribe` to `ops` from `"live"` and wait for `subscribed`. Its
   `live_offset` is the tail `L`, and every op from `L` on will arrive as an
   event, including any published while the next step is in flight.
2. `cache_get` key `latest` of `snap`. Decode the snapshot with
   `decodeSnapshot` from `model/`; it holds the room through offset `N`.
3. Drop buffered events at or below `N`. If `N + 1 < L`, `subscribe` to `ops`
   from `N + 1` to read the ops in between. With no snapshot, subscribe from 0.

Reading the snapshot before subscribing would lose the ops published between
the two. [design.md](design.md#join-and-snapshot) explains the rule.

## Reading history

A page may open more than one connection to the same room; each joins and is
narrowed on its own. The canvas reads a room's history over a second one, so
its live subscription is never replaced:

1. `join` the room with the same ID token, then `subscribe` to `ops` from 0.
   `subscribed` names the tail `L`; history is loaded once every offset below
   `L` has arrived, and later events extend it.
2. A jump in offsets is a drop, as on any subscription: `subscribe` again from
   the first offset missing.
3. A `trimmed` answer means retention has discarded the start of the log. Read
   the snapshot with `cache_get` and `subscribe` from its offset plus one;
   history starts there.

Closing the connection ends the read. The gateway keeps nothing about it, and
reading again later subscribes from the first offset the page does not hold.
[design.md](design.md#history-and-the-time-scrubber) describes what the page
does with it.

## Slow browsers

The gateway holds up to 1,024 events for a browser that is not reading. Past
that it stops reading the Felix subscription, and Felix's bounded
per-subscriber queue drops new events. The gateway never drops on its own, so a
loss always shows up as a gap in offsets.

The browser finds a loss in two ways:

1. An `ops` event whose offset is past the one its subscription should deliver
   next, after allowing for `skipped_before`. It subscribes again from the last
   offset it applied plus one.
2. A peer's presence `at` (see [Presence payload](#presence-payload)) still
   above its own applied count two seconds after it arrived. Felix drops the
   newest records, so when the last records of a burst are the ones dropped,
   nothing arrives after them to show the gap. Every session publishes presence
   at least every 3 seconds, so this finds the loss within a few seconds. The
   grace period covers the normal case where a cursor message overtakes the
   change it reports.

Either way the browser shows that it is catching up, reads the missing records
from the log, and ends with the same state hash as everyone else.

## Op payload

Payloads are opaque to the gateway. The canvas encodes ops on `ops` with the
`model/` package: a MessagePack map with these keys.

| Key | MessagePack type | Meaning |
|---|---|---|
| `sid` | uint | The authoring session, a u64 |
| `seq` | uint | The session's op counter, a u32 |
| `shape` | bin 16 | The target shape id, a u128, big-endian |
| `kind` | uint | 0 create, 1 patch, 2 delete, 3 text |
| `fields` | map | Only the fields this op changes; for `text`, the one field `y` |
| `t` | uint, optional | When the author made the edit, in milliseconds since 1970 by its own clock. Only history shows it; the fold ignores it, and a value that is not a time is dropped |

A move (a patch of `x` and `y`) encodes in about 90 bytes, 11 of them the time.

### Shape fields

A `create` carries every field of the new shape; a `patch` carries only those it
changes. The fold in `model/` applies them last-writer-wins per field on log
offset, and ignores a patch to a shape that does not exist, so a delete is final.

| Field | Shapes | Meaning |
|---|---|---|
| `type` | all | `rect`, `ellipse`, `line`, `stroke` or `text`. A create with any other type is ignored. Never changes |
| `x`, `y` | all | The top-left corner, or a line's start, in canvas units |
| `w`, `h` | all | Size; for a line, the offset from start to end, which may be negative. A `text` shape's height follows its text, so its `h` is unused, and a `w` of 0 makes it grow with its longest line |
| `z` | all | A fractional-index key: shapes stack in key order, then by id. A value that is not a key is ignored |
| `points` | `stroke` | Pairs of coordinates relative to `x, y`. Never changes once created |

### Text

A `text` op changes the rich text of a `text` shape, a rectangle or an
ellipse. Its one field, `y`, is a [Yjs](https://docs.yjs.dev) update in Yjs's
version 2 encoding, to a document with one root XML fragment named `body`.
The fold applies it to that shape's document, so concurrent typing merges
instead of one person's text replacing another's. A shape's first `text` op
creates its body, and a delete removes it.

The fold ignores a `text` op on a shape that does not exist, on a line or a
stroke, or whose update does not decode or is over 64 KB. A session's Yjs
client id is the low 32 bits of its `sid` XORed with the high 32.

The fragment holds what the editor writes through `y-prosemirror`:

| Element | Attributes | Holds |
|---|---|---|
| `p` | none | Text |
| `h` | `level`: 1, 2 or 3 | Text |
| `ul`, `ol` | none | `li` elements |
| `li` | none | A `p`, then any blocks, including lists nested up to three deep |

Text carries marks as Yjs formatting attributes, each a map:

| Mark | Value | Meaning |
|---|---|---|
| `b`, `i`, `u` | `{}` | Bold, italic, underline |
| `a` | `{ href }` | A link; only `http:`, `https:` and `mailto:` addresses count |
| `size` | `{ step }` | `small`, `large` or `huge`: 12, 20 or 28 canvas units against Medium's 16 |
| `color` | `{ name }` | `muted`, `coral`, `orange`, `amber`, `green`, `blue`, `violet`, `magenta` or `rose`; Ink when absent |

Anything else in the document is kept but never shown, and the state hash
leaves it out.

## Presence payload

Records on `presence` are MessagePack maps, published fire-and-forget at most
every 40 ms while the pointer or selection moves, and every 3 seconds
otherwise. A session not heard from for 10 seconds is treated as gone.

| Key | MessagePack type | Meaning |
|---|---|---|
| `sid` | uint | The session, as in ops |
| `n` | uint | Increases with every message, so a session can time its own echo |
| `name` | str | Display name |
| `color` | uint | Index into the eight-colour presence palette |
| `x`, `y` | float or nil | The pointer in canvas units, nil when it left the canvas |
| `sel` | array of bin 16 | Ids of the selected shapes |
| `gone` | bool | Present and true on a session's last message |
| `at` | uint | How many changes the session has applied: the next offset it needs. Optional |
| `txt` | array, optional | While the session edits text: `[shape, anchor, head]`, the shape id as bin 16 and the selection's two ends as encoded Yjs relative positions (`Y.encodeRelativePosition`), so a caret stays on its character while others type before it |

The canvas samples the pointer once per animation frame and sends at most one
message per 40 ms, 25 a second, which leaves room under the gateway's
per-session write rate for ops. Cursors on other screens are eased toward each
new position with a critically damped spring, so they still move smoothly.

## Member payload

A member entry is a MessagePack map, encoded by `encodeMember` in `model/`.

| Key | MessagePack type | Meaning |
|---|---|---|
| `name` | str | Display name, at most 24 characters |
| `color` | uint | Index into the presence palette |
| `person` | uint | A u64 hash of the signed-in account: the 64-bit FNV-1a of the JSON array `[iss, sub]` from the ID token |

The key is the session, which is new on every page load; `person` stays the
same for every tab and every visit signed in to one account, so the canvas
uses it for anything that should outlast a reload. Two windows signed in to
different accounts are two people, even in one browser. A
person's colour is their `person` modulo eight, moved on to the next free
colour while someone with a smaller `person` holds it. Everyone sees the same
member list, so everyone settles on the same colours, and a reload keeps them.
The people list shows each person once, however many tabs they have open or
however many entries an unclean reload left behind.

## Snapshot payload

The snapshotter writes key `latest` of `canvas.snap.<room>` with `encodeSnapshot` from
`model/`: a MessagePack map with these keys.

| Key | MessagePack type | Meaning |
|---|---|---|
| `v` | uint | Format version, 2. Version 1 had no `texts` and still decodes |
| `offset` | uint | The last log offset folded in. Continue from `offset + 1` |
| `shapes` | array | One `[id, fields, written]` per shape: the id as bin 16, the fields as in ops, and a map from field name to the offset that last wrote it |
| `seqs` | array | One `[sid, seq]` per session: the highest `seq` folded in, so a retried op that lands later is still recognised as a repeat |
| `texts` | array | One `[id, state]` per body: the shape id as bin 16 and `Y.encodeStateAsUpdateV2` of its document |
