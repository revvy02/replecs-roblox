--[[
	Client replecs bootstrap. Mirrors the game's wiring: requires the shared
	client replicator module, applies the initial full snapshot, then ongoing
	updates from the server.

	The test suite reaches the same client world by requiring the same modules
	(shared/world, shared/cts) from client-context runCode.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local replicator = require(script.Parent.replicator)
replicator:init()

local handshake = ReplicatedStorage:WaitForChild("ReplecsHandshake")
local updates = ReplicatedStorage:WaitForChild("ReplecsUpdates")

updates.OnClientEvent:Connect(function(buf, variants)
	replicator:apply_updates(buf, variants)
end)

task.spawn(function()
	local buf, variants = handshake:InvokeServer()
	if buf then
		replicator:apply_full(buf, variants)
	end
end)
