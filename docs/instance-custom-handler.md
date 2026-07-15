# Design: `instance_custom_handler` — instance-aware entity reconciliation

> Status: **design only, not implemented.** Captures the discussion that led here so we
> can build it deliberately.

## Problem

When a component's value is a Roblox `Instance` and that instance is replicated via
replecs_roblox (`pair(InstanceProtocol, component)` / the `instance` protocol), the
**value is no longer in the replication packet** — it arrives out of band as a `u32`
`InstanceId` and is resolved asynchronously from a CollectionService tag/attribute.

replecs' built-in **`custom_handler`** (entity reconciliation) resolves an entity by
looking up the component **value in the replication buffer** and calling
`handler(value)` (see `replecs/src/client.luau`, `process()` →
`find_component_in_buffer(buffer, component)`):

```lua
local value = find_component_in_buffer(command_buffer, component)
if value then
    new_entity = handler(value.value)   -- ref(instance) → reconciles
else
    log_warn("No component found for custom id handler: ...")
    new_entity = handler(nil)            -- ref(nil) → a NEW entity (duplicate!)
end
```

With instance networking the buffer lookup **always misses** (the value isn't a
component value), so `handler(nil)` runs every time. With a handler like
`function(player) return ref(player) end`, `ref(nil)` mints a fresh entity — a
**duplicate** that never merges with the locally-known entity for the same instance.

### Observed symptom (the bug that motivated this)

On a client, each player ended up with **two** entities:

| entity | source | `cts.Player` | `LocalPlayer` tag | server id | carries |
|---|---|---|---|---|---|
| `ref(localPlayer)` | local (`playersExist`, `camera.luau`) | ✅ | ✅ | none | the **view** |
| `ref(nil)` | replication (`handler(nil)`) | ✅ | — | yes | the **character** |

Character `ChildOf` the replicated entity, view `ChildOf` the local one. Any system
that traverses character → player → view (e.g. arm motion-influence reparenting,
`deriveMouseIconEnabled`) breaks because they live under different player entities.

### Why returning `nil` from the handler does NOT help

If the handler returns `nil`:

- `new_entity = nil` → no client entity is created, the server↔client id mapping is
  never written, and the entity's **buffered components are dropped** (the second
  processing loop skips negative/custom ids).
- `processed[server_entity] = true`; the server won't re-send → **no retry**.
- And because the entity is never created, the `pair(InstanceId, component)` is never
  applied to it, so the async instance value has **nowhere to land** — it can never
  self-heal. Strictly worse than the duplicate (which at least yields an entity).

Conclusion: the value-based `custom_handler` **requires the value in-buffer**, and the
instance path deliberately puts it out of band. They are incompatible as wired, and no
handler return value bridges it.

## Proposed API

Provide a replecs_roblox API that is **isomorphic to replecs' custom APIs** but for
instance-valued components.

- `custom_handler(component, fn)` → `fn(value)` where `value` is the in-buffer value.
- **`instance_custom_handler(component, fn)`** → `fn(value)` where `value` is the
  **resolved instance** — replecs_roblox does the `InstanceId` → instance plumbing so
  the handler reads identically to a normal custom handler.

```lua
-- you write the obvious thing; the value is a guaranteed-present instance
roblox:instance_custom_handler(cts.Player, function(player)
    return ref(player)
end)
```

### Decoupled from `ref`

replecs_roblox does **not** depend on `ref`. It only guarantees the **instance is
present** when it calls your `fn`. Inside `fn` you decide what to do — `ref(instance)`,
use the instance directly, or your own registry. `ref` is the game's concern, not the
library's. (`id` is the internal reconciliation key; what the entity *is* is the
handler's choice.)

## The guarantee *is* the feature: deferral is core, not optional

"Guarantee the instance is there before calling `fn`" is the entire point — it's what
lets you write `fn(instance)` and what avoids the in-buffer problem that breaks the
plain `custom_handler`. An `instance_custom_handler` that only worked when the instance
*happened* to already be present would just be a renamed `custom_handler` with the same
limitation; it would solve nothing. **So the deferred path is the contract, not a
follow-up.**

When the ECS entity arrives **before** the instance (the streaming case — ECS and
instance streaming travel on independent channels), replecs_roblox must **defer**
calling `fn`, and **buffer the entity's replicated data**, until the instance resolves;
then it runs `fn(instance)` and applies the buffered data to the returned entity.

Two paths — same contract, the first is just an optimization of the second:

- **Instance already present at reconcile** (players, Studio-placed instances): call
  `fn(instance)` immediately, apply data. No buffering needed. (Fast path; covers the
  current player/character bug.)
- **Instance streams in later**: stash the pending entity's components, run `fn` on
  resolve, apply. This is the path that delivers the guarantee for streamed instances,
  and it **must** exist for the API to mean what it says.

### Why deferral is forced (given the ref-decoupling)

The two ways to avoid deferral both reintroduce coupling:

1. Reconcile to replecs_roblox's *own* id-keyed entity now, then `fn` returns
   `ref(instance)` — a **different** entity → requires component **migration**, which
   breaks any cross-entity pair references pointing at the proxy.
2. Have replecs_roblox key its entity through `ref(instance)` itself so they match —
   that's **coupling to `ref`**, which we're explicitly avoiding.

So: **decoupled-from-`ref` + guaranteed-instance ⟹ deferral.** That's the honest cost,
and it's acceptable. The implementation is "call-now when present, defer-and-replay
when streamed."

## Reconciliation invariants

- **`InstanceId` (the `u32`) is the reconciliation key.** It's always in the buffer
  (`ctx.pair_value(InstanceId, component)`), independent of whether the instance has
  resolved. Reconciliation is therefore total and synchronous in identity — it never
  needs the resolved instance to *decide which entity*.
- **The component value (the instance) is orthogonal and async.** It lands on the
  reconciled entity when the tag resolves; systems gate on its presence as normal ECS
  behavior (a query simply doesn't match until the component is set). "Not there yet" =
  "not processed yet."
- **One entity per `InstanceId`.** All replicated references to the same instance id
  reconcile to the same client entity.

## Core implementation question: the pending-replication buffer

This is the thing that must be solved, because the deferred path is the contract (not a
nice-to-have). replecs_roblox must **capture a pending entity's replicated components
and replay them** when the instance resolves.

**replecs will NOT hold it for us** (verified in `replecs/src/client.luau`):

- A custom handler controls the entity **mapping** (which client entity a server entity
  reconciles to) and supports **intra-packet** dependency resolution (`ctx.entity(...)`,
  `entity_set_postponed_pair` for pair targets that are themselves unresolved custom
  entities). It does **not** support deferring a reconciliation to a later frame.
- `apply_full`/`apply_entity`/`apply_updates` each start with `client.command_buffers =
  {}` (a fresh table), so the previous packet's unresolved buffers are **dropped**, not
  retained. If the handler returns `nil`, the entity isn't created, its components aren't
  applied, and there's **no re-queue** (`resolve_dirty` only rebuilds the shared lookup).
  The server considers the entity sent, so it won't resend.

So the handler must return an entity **during the packet**, or the data is lost. The
"control when entities reconcile" replecs offers is intra-packet ordering, not
inter-frame deferral.

**Therefore replecs_roblox must return a real entity during the packet** (so replecs
applies the components instead of dropping them) — i.e. reconcile-by-id to a stable
entity *now* — and run `fn(instance)` later, on `instanceAdded`. That ordering creates a
trilemma for the **streamed** case (the fast path below avoids it):

> For a streamed instance you cannot have all three of:
> 1. **decoupled from `ref`** (replecs_roblox never calls `ref`/`ref.set`; only `fn` does),
> 2. **streamed support** (entity arrives before the instance), and
> 3. **auto-unification** (a later `ref(instance)` in game code returns the same entity).
>
> Because data must land on an entity *now*, but `fn` (which decides the canonical
> entity, typically `ref(instance)`) can only run once the instance exists.

Pick one to give up:

- **Accept migration** (keep 1+2, drop clean 3): land data on the stable id-entity, run
  `fn(instance)` on resolve, then migrate/alias the stable entity's state onto `fn`'s
  entity. Fragile — cross-entity pair references point at the stable entity.
- **Couple to `ref` internally** (keep 2+3, drop 1): on resolve, `ref.set(instance,
  stableEntity)` so `ref(instance)` *is* the data entity and `fn` needs no migration.
  Clean and unified, but replecs_roblox now touches `ref`.
- **Drop auto-unification** (keep 1+2, drop 3): game code references replecs_roblox's
  stable id-entity directly instead of `ref(instance)`. No migration, no `ref` coupling,
  but `ref(player)` no longer "just works" for streamed entities.

### The fast path has no trilemma

When the instance is **already present at reconcile** (players, Studio-placed instances),
replecs_roblox calls `fn(instance)` immediately, `fn` returns `ref(instance)`, that *is*
the reconcile entity — all three properties hold at once, no buffering, no migration, no
`ref` coupling (the user's `fn` is the only thing that touched `ref`). This covers the
player/character bug completely and can ship first. The streamed path is the part that
forces the trilemma decision above.

## Architecture: streamed-instance-as-source-of-truth (interest-managed replication)

The existing `taggedInstances` system makes **server-authoritative** entities and
replicates *all* of them to *all* clients; when an instance streams in, it reconciles
onto the already-networked client entity. That works, but it doesn't scale — every
tagged entity is replicated to everyone regardless of what they've streamed in.

An alternative inverts it: **the streamed instance is the interest unit**, and the
server replicates an entity **on demand**, only to clients that have it streamed in.

Flow:

1. Tagged instance streams in on the client, carrying its `InstanceId` as a
   **persistent attribute** (baked / pre-assigned, not runtime `nextId++`).
2. Client reads the id and requests "replicate the entity for `InstanceId X`."
3. Server finds its authoritative entity by `X`, **scopes it to that client**, replicates.
4. Entity arrives with `pair(InstanceId, X)` → `instance_custom_handler` reconciles by `X`.
5. The instance is **already present** (step 1 preceded the request), so it unifies the
   client's streamed-instance entity with the server's data — one entity, keyed by `X`.

### Why this is a *good* fit for `instance_custom_handler`

The deferral complication above exists because, in general streaming, the ECS entity can
arrive **before** the instance. This model inverts the ordering by construction —
**stream-in → request → replicate** — so the instance is **guaranteed present** when the
entity arrives. It only ever hits the no-deferral fast path. If the project commits to
this model, full streaming-deferral support in `instance_custom_handler` becomes less
urgent: the request ordering provides the synchronization.

### What's new here is NOT reconciliation

Reconciliation falls out for free (the instance id is the shared key on both sides). The
remaining machinery is **interest-managed / on-demand replication**, orthogonal to
`instance_custom_handler` — and the hard part (scoping) is **already a replecs
primitive**:

1. **Scoped replication — supported natively by replecs.** `Replecs.networked` (and
   `reliable`/`unreliable`/`relation`/pairs) take an optional `AnyFilter`:
   `Player | PlayerFilter (a player set) | (player: Player) -> boolean`, via
   `world:set(e, Replecs.networked, filter)` or `replicator:set_networked(e, filter)`
   (backed by replecs' masking controller). So per-client scoping needs **no new
   replication primitive**: keep a per-entity player set of "clients that have this
   instance streamed in" and use it as the entity's networked filter.
2. **Request channel** — client→server "I have `X`, send its entity," plus the inverse
   on stream-out ("I lost `X`, stop"). Application-level; on stream-in add the requester
   to the entity's filter set, on stream-out remove them.
3. **Stable/persistent `InstanceId`s** baked as attributes so the client can request by
   id immediately on stream-in (no round-trip to learn the id). (replecs_roblox
   currently assigns ids at runtime via `nextId++`; this model wants them pre-assigned.)
4. **Stream-out teardown** — likely remove the client from the filter + delete the
   reconciled client entity (or keep a shell), TBD.

### Takeaway

`instance_custom_handler` handles the easy half (reconciliation) and even avoids the
deferral edge case under this ordering. The other half — **scoped on-demand
replication** — is no longer a risk: replecs already provides per-client scoping via
`AnyFilter`, so the only new work is **application-level orchestration** (a request
channel + maintaining each entity's filter set as clients stream the instance in/out)
plus stable baked ids. Payoff: each client replicates only what it has streamed in, with
the instance as the natural interest unit.

## Use cases

Use it wherever a Roblox `Instance` has a canonical existence on the client
*independent of replication*, and both the server (via replication) and the client
(locally) want to attach ECS data to that same instance:

- **Local player + character** — view/camera/input/viewmodel reference them locally;
  server replicates state onto the same entity. (The motivating case.)
- **Studio-placed / shared world instances** — doors, spawns, interactables, vehicles;
  present on every client before replication, server owns state, client adds behavior.
- **StreamingEnabled parts** — stable entity identity across stream cycles, consistent
  with the server entity; component appears/disappears as the part streams.
- **NPCs the client decorates locally** — nameplates/outlines keyed off `ref(model)`
  land on the same entity the server replicates.
- **Client-predicted → server-confirmed handoff** — merge a predicted instance entity
  into the confirmed one instead of leaving a ghost.

Where it's **not** needed: pure server-authoritative entities with no independent
client instance (a server-only projectile known only via replication, a data-only
singleton). Normal get-or-create replication is correct and simpler there.

## Migration in the game (once built)

- Replace `pair(Replecs.custom, cts.Player)` (in `playersExist`) and the value-based
  `custom_handler` meta on `cts.Player` with `instance_custom_handler(cts.Player, fn)`.
- Keep `pair(AutoNetwork, ReplecsRoblox.instance)` for the value replication.
- Result: a single player entity (character + view share it); `ref(player)` works.
