-- Shared jecs world, required identically by the server Script and the client
-- LocalScript so preregistered component ids line up across the two VMs.
--
-- Mirrors the game's world.luau: replecs (and anything that preregisters
-- components, like replecs-rbx) MUST be required before the world is created.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local packages = ReplicatedStorage.packages

require(packages.replecs)
require(packages.replecs_rbx)

local Jecs = require(packages.jecs)

return Jecs.world(true)
