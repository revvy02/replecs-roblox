# replecs-rbx

Bridges [replecs](https://github.com/pepeeltoro41/replecs)' component-driven replication with
Roblox `Instance` references. Components are preregistered so `InstanceGuid` + `InstanceProtocol`
share IDs across every world, matching replecs's own preregistration model.

## Usage

```lua
local replecs = require(path.to.replecs)
local rbx = require(path.to.replecs_rbx)

-- server
local replicator = rbx.extend_server(replecs.create_server(world))
replicator:set_instance(entity, cts.BasePart)  -- starts replicating

-- client
rbx.extend_client(replecs.create_client(world))
```

Two equivalent ways to drive replication on the server:

```lua
world:add(e, pair(replicator.components.instance, cts.BasePart))  -- declarative
replicator:set_instance(e, cts.BasePart)                          -- imperative
```

## Development

This project uses [mise](https://mise.jdx.dev/) + [pesde](https://pesde.dev/) +
[rodeo](https://github.com/revvy02/rodeo) + [bun](https://bun.sh/).

The rodeo client used by the test harness is vendored as a git submodule under
`vendor/rodeo`, so clone with submodules:

```sh
git clone --recursive git@github.com:revvy02/replecs-rbx.git
# or, in an existing checkout:
git submodule update --init --recursive
```

Then:

```sh
mise install        # install the toolchain (rojo, rodeo, bun, pesde, darklua)
mise run install    # pesde install (Roblox packages) + bun install (test deps)
mise run test       # build the test place and run the multiplayer replication test
```

Tests run as a bun-orchestrated isolated multiplayer test (a real server VM + client VM)
driven through the rodeo TypeScript client (`@rodeo/client`, from the `vendor/rodeo`
submodule). The server replicates an entity whose component points at a tagged Part; the
client asserts the reference reconciles back to its local copy of that Part. See
`run-tests.ts`.
