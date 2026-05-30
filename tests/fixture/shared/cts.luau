-- Shared component dictionary. Mirrors the game's cts.luau pattern: create
-- components on the shared world, name them, and mark every one with
-- Replecs.shared so they survive the handshake with matching ids on both sides.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local packages = ReplicatedStorage.packages

local Jecs = require(packages.jecs)
local Replecs = require(packages.replecs)

local world = require(script.Parent.world)

local cts = {
	-- carries the replicated Instance reference (driven via replecs-rbx set_instance)
	Target = world:component(),
	-- a plain value component, to exercise ordinary replication alongside it
	Health = world:component(),
}

for name, ct in cts do
	world:set(ct, Jecs.Name, name)
	world:add(ct, Replecs.shared)
end

return cts
