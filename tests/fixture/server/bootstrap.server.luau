--[[
	Server replecs bootstrap. Mirrors the game's wiring: requires the shared
	server replicator module, then drives the transport — the initial
	full-snapshot handshake over a RemoteFunction and per-frame update
	collection over a RemoteEvent.

	The test suite reaches the same replecs server + world simply by requiring
	the same modules (server/replicator, shared/world, shared/cts) from server-
	context runCode — no _G, no shared globals.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local replicator = require(script.Parent.replicator)

local handshake = Instance.new("RemoteFunction")
handshake.Name = "ReplecsHandshake"
handshake.Parent = ReplicatedStorage

local updates = Instance.new("RemoteEvent")
updates.Name = "ReplecsUpdates"
updates.Parent = ReplicatedStorage

replicator:init()

handshake.OnServerInvoke = function(player)
	if not replicator:is_player_ready(player) then
		replicator:mark_player_ready(player)
	end
	return replicator:get_full(player)
end

RunService.Heartbeat:Connect(function()
	for player, buf, variants in replicator:collect_updates() do
		updates:FireClient(player, buf, variants)
	end
end)
