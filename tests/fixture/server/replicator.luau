-- Server replicator module. Mirrors the game's server/ecs/replicator.luau:
-- a single memoized instance shared by everything that requires it — the
-- bootstrap (which drives the transport) and the test runCode (which drives
-- scenarios), so both operate on the same replecs server + world.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local packages = ReplicatedStorage.packages

local replecs = require(packages.replecs)
local rbx = require(packages.replecs_rbx)
local world = require(ReplicatedStorage.shared.world)

-- Register every shared component (cts) before the replicator is created/init'd,
-- so the server and client agree on the shared set during the handshake.
require(ReplicatedStorage.shared.cts)

return rbx.extend_server(replecs.create_server(world))
