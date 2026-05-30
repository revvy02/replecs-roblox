--[[
    Bridges replecs's component-driven replication with Roblox Instance
    references. Components are preregistered (see how_to/011 in jecs) so
    InstanceGuid + InstanceProtocol share IDs across every world, matching
    replecs's own preregistration model.

    Usage:
      local replicator = replecs.create_server(world)
      rbx.extend_server(replicator)
      replicator:set_instance(entity, cts.BasePart)  -- starts replicating

    Two equivalent ways to drive replication:
      world:add(e, pair(replicator.components.instance, cts.BasePart))   -- declarative
      replicator:set_instance(e, cts.BasePart)                            -- imperative
]]

local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")

-- Dependencies resolve as siblings of this package (the standard pesde Roblox
-- layout: pesde links each dependency alias next to the package). No string
-- requires, no darklua build step.
local Jecs = require(script.Parent.jecs)
local pair = Jecs.pair
local pair_second = Jecs.pair_second

local Replecs = require(script.Parent.replecs)

local JecsUtils = require(script.Parent.jecs_utils)
local monitor = JecsUtils.monitor
local observer = JecsUtils.observer

local TAG = "replecs-rbx.Instance"
local ATTR = "replecs-rbx.InstanceGuid"

-- Preregister so every world sees the same component IDs.
-- InstanceGuid carries Replecs.shared so replecs treats it as a known
-- cross-side component during handshakes.
local InstanceGuid = Jecs.component() :: Jecs.Id<string>
Jecs.meta(InstanceGuid, Jecs.Name, "replecs-rbx.InstanceGuid")
Jecs.meta(InstanceGuid, Replecs.shared)

local InstanceProtocol = Jecs.component()
Jecs.meta(InstanceProtocol, Jecs.Name, "replecs-rbx.InstanceProtocol")

local function setupNetworkedInstanceReconciler(world: Jecs.World)
	local guidToEntityComponents = {}
	local guidToInstance = {}
	local instanceToEntityComponents = {}

	local function ensureMap(guid)
		local map = guidToEntityComponents[guid]
		if not map then
			map = {}
			guidToEntityComponents[guid] = map
		end
		return map
	end

	local function instanceAdded(instance)
		local guid = instance:GetAttribute(ATTR)
		local map = ensureMap(guid)

		guidToInstance[guid] = instance
		instanceToEntityComponents[instance] = map

		for e, components in map do
			for ct in components do
				world:set(e, ct, instance)
			end
		end
	end

	local function instanceRemoved(instance)
		local map = instanceToEntityComponents[instance]

		for e, components in map do
			for ct in components do
				world:remove(e, ct)
			end
		end

		instanceToEntityComponents[instance] = nil
	end

	world:added(InstanceGuid, function(e, p, guid)
		local ct = pair_second(world, p)
		local map = ensureMap(guid)

		if not map[e] then
			map[e] = {}
		end
		map[e][ct] = true

		local instance = guidToInstance[guid]
		if instance then
			world:set(e, ct, instance)
		end
	end)

	world:removed(InstanceGuid, function(e, p)
		local ct = pair_second(world, p)
		local guid = world:get(e, p)
		local map = guidToEntityComponents[guid]

		map[e][ct] = nil
		if not next(map[e]) then
			map[e] = nil
		end
	end)

	for _, instance in CollectionService:GetTagged(TAG) do
		instanceAdded(instance)
	end
	CollectionService:GetInstanceAddedSignal(TAG):Connect(instanceAdded)
	CollectionService:GetInstanceRemovedSignal(TAG):Connect(instanceRemoved)
end

export type RbxComponents = {
	instance_guid: Jecs.Id<string>,
	instance: Jecs.Entity,
}

-- The `components` field is intersected with replecs's own components table at
-- the ExtendedServer/ExtendedClient level, so `replicator.components.shared`
-- still works alongside `replicator.components.instance`.
export type ServerExtension = {
	components: RbxComponents,
	set_instance: (self: ServerExtension, entity: Jecs.Entity, component: Jecs.Entity) -> (),
	stop_instance: (self: ServerExtension, entity: Jecs.Entity, component: Jecs.Entity) -> (),
}

export type ClientExtension = {
	components: RbxComponents,
}

export type ExtendedServer = Replecs.Server & ServerExtension
export type ExtendedClient = Replecs.Client & ClientExtension

local function extend_server(replicator: Replecs.Server): ExtendedServer
	local world = replicator.world

	setupNetworkedInstanceReconciler(world)

	-- We do NOT handle the case where two distinct Instances carry the same guid
	-- (e.g. a live networked instance got Clone()'d, or a template in storage was
	-- replicated before being cloned, or a saved place baked the attribute in).
	-- That's indicative of a different core issue — clone from templates, don't
	-- replicate templates. silently regenerating here would just paper over
	-- the bug.
	--
	-- Reference implementation if we ever want a debug mode that wipes inherited
	-- identity on first-sight of an Instance (membership in the weak-keyed set
	-- means "already given a session-unique identity this run"):
	--
	-- local initializedInstances = setmetatable({} :: { [Instance]: true }, { __mode = "k" })
	--
	-- local function ensureInstanceGuid(instance: Instance): string
	-- 	if initializedInstances[instance] then
	-- 		return instance:GetAttribute(ATTR) :: string
	-- 	end
	-- 	initializedInstances[instance] = true
	-- 	instance:RemoveTag(TAG)
	-- 	local guid = HttpService:GenerateGUID(false)
	-- 	instance:SetAttribute(ATTR, guid)
	-- 	instance:AddTag(TAG)
	-- 	return guid
	-- end
	--
	-- local function replicateInstance(entity, component, instance: Instance)
	-- 	local pairId = pair(InstanceGuid, component)
	-- 	world:set(entity, pairId, ensureInstanceGuid(instance))
	-- 	replicator:set_pair(entity, pairId)
	-- end
	local function replicateInstance(entity, component, instance: Instance)
		local guid = instance:GetAttribute(ATTR)
		local pairId = pair(InstanceGuid, component)

		if not guid then
			guid = HttpService:GenerateGUID(false)
			instance:SetAttribute(ATTR, guid)
			instance:AddTag(TAG)
		end

		world:set(entity, pairId, guid)
		replicator:set_pair(entity, pairId)
	end

	local function stopReplicateInstance(entity, component, deleting)
		local pairId = pair(InstanceGuid, component)
		replicator:stop_pair(entity, pairId)
		if not deleting then
			world:remove(entity, pairId)
		end
	end

	-- gates the per-component Jecs hooks so they install exactly once
	local hookedComponents: { [any]: true } = {}

	local function ensureComponentHook(component)
		if hookedComponents[component] then
			return
		end
		hookedComponents[component] = true

		local protocolPair = pair(InstanceProtocol, component)

		monitor(world:query(component):with(protocolPair)).removed(function(e, deleting)
			stopReplicateInstance(e, component, deleting)
		end)

		observer(world:query(component):with(protocolPair), function(e)
			replicateInstance(e, component, world:get(e, component))
		end)
	end

	-- The InstanceProtocol pair IS the subscription. Bridge installs the per-component
	-- hooks the first time a protocol is added, and syncs any value that's already there.
	world:added(InstanceProtocol, function(entity, p)
		local component = pair_second(world, p)
		ensureComponentHook(component)
		local existing = world:get(entity, component)
		if existing then
			replicateInstance(entity, component, existing)
		end
	end)
	world:removed(InstanceProtocol, function(entity, p, deleting)
		stopReplicateInstance(entity, pair_second(world, p), deleting)
	end)

	local extended = replicator :: ExtendedServer
	-- Mutates replecs's global components table (same object in preregister mode).
	extended.components.instance_guid = InstanceGuid
	extended.components.instance = InstanceProtocol
	extended.set_instance = function(_, entity, component)
		world:add(entity, pair(InstanceProtocol, component))
	end
	extended.stop_instance = function(_, entity, component)
		world:remove(entity, pair(InstanceProtocol, component))
	end

	return extended
end

local function extend_client(replicator: Replecs.Client): ExtendedClient
	setupNetworkedInstanceReconciler(replicator.world)

	local extended = replicator :: ExtendedClient
	extended.components.instance_guid = InstanceGuid
	extended.components.instance = InstanceProtocol

	return extended
end

return {
	extend_server = extend_server,
	extend_client = extend_client,

	instance_guid = InstanceGuid,
	instance = InstanceProtocol,
}
