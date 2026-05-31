# replecs-roblox

Extends [replecs](https://github.com/pepeeltoro41/replecs)' replicator with a
StreamingEnabled-compatible instance replication API.

## Usage

Extend a replecs replicator on each side:

```lua
local replecs = require(path.to.replecs)
local replecs_roblox = require(path.to.replecs_roblox)

-- server
local replicator = replecs_roblox.extend_server(replecs.create_server(world))

-- client
local replicator = replecs_roblox.extend_client(replecs.create_client(world))
```

### Imperative API

```lua
local e = world:entity()
world:set(e, cts.BasePart, part)
replicator:set_networked(e)

replicator:set_instance(e, cts.BasePart)
replicator:stop_instance(e, cts.BasePart)
-- or, to keep the client's resolved instance after stopping:
replicator:stop_instance(e, cts.BasePart, true)
```

### Declarative API

```lua
local e = world:entity()
world:set(e, cts.BasePart, part)
world:add(e, replecs.networked)

world:add(e, pair(replecs_roblox.instance, cts.BasePart))
world:remove(e, pair(replecs_roblox.instance, cts.BasePart))
```
