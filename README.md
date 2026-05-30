# replecs-roblox

Extends [replecs](https://github.com/pepeeltoro41/replecs)' replicator with a
StreamingEnabled-compatible instance replication API.

## Usage

Extend a replecs replicator on each side:

```lua
local replecs = require(path.to.replecs)
local rbx = require(path.to.replecs_roblox)

-- server
local replicator = rbx.extend_server(replecs.create_server(world))

-- client
local replicator = rbx.extend_client(replecs.create_client(world))
```

### Imperative API

```lua
local e = world:entity()
world:set(e, cts.Target, part) -- a component holding an Instance
replicator:set_networked(e)

replicator:set_instance(e, cts.Target)  -- start replicating the reference
replicator:stop_instance(e, cts.Target) -- stop
```

### Declarative API

```lua
local e = world:entity()
world:set(e, cts.Target, part) -- a component holding an Instance
replicator:set_networked(e)

world:add(e, pair(replicator.components.instance, cts.Target))    -- start
world:remove(e, pair(replicator.components.instance, cts.Target)) -- stop
```
