--!optimize 2
--!native

local CollectionService = game:GetService("CollectionService")

local Jecs = require(script.Parent.jecs)
local pair = Jecs.pair
local pair_second = Jecs.pair_second

local Replecs = require(script.Parent.replecs)

local JecsUtils = require(script.Parent.jecs_utils)
local monitor = JecsUtils.monitor
local observer = JecsUtils.observer

local TAG = "replecs-roblox.Instance"
local ATTR = "replecs-roblox.InstanceId"

local InstanceId = Jecs.component() :: Jecs.Id<number>
Jecs.meta(InstanceId, Jecs.Name, "replecs-roblox.InstanceId")
Jecs.meta(InstanceId, Replecs.shared)
Jecs.meta(InstanceId, Replecs.serdes, {
	bytespan = 4,
	serialize = function(id: number): buffer
		local b = buffer.create(4)
		buffer.writeu32(b, 0, id)
		return b
	end,
	deserialize = function(b: buffer): number
		return buffer.readu32(b, 0)
	end,
})

local InstanceProtocol = Jecs.component()
Jecs.meta(InstanceProtocol, Jecs.Name, "replecs-roblox.InstanceProtocol")

-- Relation: pair(InstanceCustom, component) marks an entity to reconcile its
-- client entity by the component's replicated instance (the parallel of
-- replecs.custom, but instance-valued). The component's InstanceCustomHandler
-- meta resolves the instance to a client entity.
local InstanceCustom = Jecs.component()
Jecs.meta(InstanceCustom, Jecs.Name, "replecs-roblox.InstanceCustom")

-- Component meta: InstanceCustomHandler holds `fn(instance) -> Entity`, the
-- instance-valued parallel of replecs.custom_handler. Set it on the instance
-- component (e.g. cts.Player) that uses instance-custom reconciliation.
local InstanceCustomHandler = Jecs.component()
Jecs.meta(InstanceCustomHandler, Jecs.Name, "replecs-roblox.InstanceCustomHandler")

-- Set by extend_client to the client-side reconciliation routine; nil on the
-- server (where the custom-id handler is never invoked). One client world per
-- process, matching the singleton InstanceId/InstanceProtocol pattern.
local clientResolve: ((ctx: any) -> any)? = nil

-- Registered on both sides so the handshake agrees by identifier; only the
-- client ever runs the handler.
local instanceCustomId = Replecs.create_custom_id("replecs-roblox.instance_custom", function(ctx)
	if clientResolve then
		return clientResolve(ctx)
	end
	return nil
end)

local function setupNetworkedInstanceReconciler(world: Jecs.World)
	local idToEntityComponents = {}
	local idToInstance = {}
	local instanceToEntityComponents = {}
	-- Stable client entity per instance id for instance-custom entities whose
	-- instance hasn't streamed in yet (so replicated data isn't dropped).
	local idToCustomEntity = {}

	local function ensureMap(id)
		local map = idToEntityComponents[id]
		if not map then
			map = {}
			idToEntityComponents[id] = map
		end
		return map
	end

	local function instanceAdded(instance)
		local id = instance:GetAttribute(ATTR)
		local map = ensureMap(id)

		idToInstance[id] = instance
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

	-- Resolve id -> instance. Falls back to a synchronous tag search so a present
	-- instance reconciles even if the InstanceAdded signal hasn't fired for it
	-- yet (the player race). Returns nil only when the instance isn't present
	-- (streamed out / not arrived).
	local function resolveInstance(id: number): Instance?
		local instance = idToInstance[id]
		if instance then
			return instance
		end
		for _, inst in CollectionService:GetTagged(TAG) do
			if inst:GetAttribute(ATTR) == id then
				idToInstance[id] = inst
				instanceToEntityComponents[inst] = ensureMap(id)
				return inst
			end
		end
		return nil
	end

	world:added(InstanceId, function(e, p, id)
		local ct = pair_second(world, p)
		local map = ensureMap(id)

		if not map[e] then
			map[e] = {}
		end
		map[e][ct] = true

		local instance = idToInstance[id]
		if instance then
			world:set(e, ct, instance)
		end
	end)

	world:removed(InstanceId, function(e, p, deleting)
		local ct = pair_second(world, p)
		local id = world:get(e, p)
		local map = idToEntityComponents[id]

		map[e][ct] = nil
		if not next(map[e]) then
			map[e] = nil
		end

		if deleting then
			return
		end
		-- The id pair is the signal that this entity references an instance.
		-- When it stops replicating, drop the resolved component. (Client-only:
		-- the server never runs this reconciler, so the caller's authoritative
		-- component is never touched here.)
		world:remove(e, ct)
	end)

	-- Instance-custom reconciliation (client): decide which client entity a
	-- replicated instance-custom entity maps to, keyed off pair(InstanceId, ct).
	clientResolve = function(ctx): Jecs.Entity?
		local component = ctx.target(InstanceId)
		if not component then
			return nil
		end
		local id = ctx.pair_value(InstanceId, component)
		local instance = resolveInstance(id)
		if instance then
			-- instance present: the component's handler decides the entity
			-- (e.g. ref(instance)), unifying with local instance->entity users.
			local handler = world:get(component, InstanceCustomHandler)
			if handler then
				return handler(instance)
			end
		end
		-- streamed instance not present yet: reconcile to a stable id-keyed
		-- entity so replicated data lands; its value resolves when the instance
		-- streams in. (Handler-based unification for not-yet-present instances is
		-- a follow-up — see docs/instance-custom-handler.md.)
		local e = idToCustomEntity[id]
		if not e then
			e = world:entity()
			idToCustomEntity[id] = e
		end
		return e
	end

	for _, instance in CollectionService:GetTagged(TAG) do
		instanceAdded(instance)
	end
	CollectionService:GetInstanceAddedSignal(TAG):Connect(instanceAdded)
	CollectionService:GetInstanceRemovedSignal(TAG):Connect(instanceRemoved)
end

export type RbxComponents = {
	instance_id: Jecs.Id<number>,
	instance: Jecs.Entity,
	instance_custom: Jecs.Entity,
	instance_custom_handler: Jecs.Entity,
}

export type ServerExtension = {
	components: RbxComponents,
	set_instance: (self: ServerExtension, entity: Jecs.Entity, component: Jecs.Entity) -> (),
	stop_instance: (self: ServerExtension, entity: Jecs.Entity, component: Jecs.Entity, keep: boolean?) -> (),
	set_instance_custom: (self: ServerExtension, entity: Jecs.Entity, component: Jecs.Entity) -> (),
	stop_instance_custom: (self: ServerExtension, entity: Jecs.Entity, component: Jecs.Entity) -> (),
}

export type ClientExtension = {
	components: RbxComponents,
}

export type ExtendedServer = Replecs.Server & ServerExtension
export type ExtendedClient = Replecs.Client & ClientExtension

local function extend_server(replicator: Replecs.Server): ExtendedServer
	local world = replicator.world
	local nextId = 0

	replicator:register_custom_id(instanceCustomId)

	local function replicateInstance(entity, component, instance: Instance)
		local id = instance:GetAttribute(ATTR)
		local pairId = pair(InstanceId, component)

		if not id then
			nextId += 1
			id = nextId
			instance:SetAttribute(ATTR, id)
			instance:AddTag(TAG)
		end

		world:set(entity, pairId, id)
		replicator:set_pair(entity, pairId)
	end

	local function stopReplicateInstance(entity, component, deleting, keep)
		local pairId = pair(InstanceId, component)

		-- Removing the protocol pair triggers both the InstanceProtocol-removed
		-- hook and the component monitor, so teardown can run twice; once the
		-- id pair is gone there's nothing left to do.
		if not world:has(entity, pairId) then
			return
		end

		-- keep = true stops tracking without telling the client to drop the
		-- id pair, so it keeps resolving the instance for as long as it exists.
		replicator:stop_pair(entity, pairId, keep)
		if not deleting then
			world:remove(entity, pairId)
		end
	end

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

	-- Instance-custom marking: pair(InstanceCustom, component) -> reconcile this
	-- entity via the registered instance custom-id.
	world:added(InstanceCustom, function(entity)
		replicator:set_custom(entity, instanceCustomId)
	end)
	world:removed(InstanceCustom, function(entity, _p, deleting)
		if deleting then
			return
		end
		replicator:remove_custom(entity)
	end)

	local extended = replicator :: ExtendedServer

	extended.components.instance_id = InstanceId
	extended.components.instance = InstanceProtocol
	extended.components.instance_custom = InstanceCustom
	extended.components.instance_custom_handler = InstanceCustomHandler
	extended.set_instance = function(_, entity, component)
		world:add(entity, pair(InstanceProtocol, component))
	end
	extended.stop_instance = function(_, entity, component, keep)
		stopReplicateInstance(entity, component, false, keep)
		world:remove(entity, pair(InstanceProtocol, component))
	end
	extended.set_instance_custom = function(_, entity, component)
		world:add(entity, pair(InstanceCustom, component))
	end
	extended.stop_instance_custom = function(_, entity, component)
		world:remove(entity, pair(InstanceCustom, component))
	end

	return extended
end

local function extend_client(replicator: Replecs.Client): ExtendedClient
	setupNetworkedInstanceReconciler(replicator.world)
	replicator:register_custom_id(instanceCustomId)

	local extended = replicator :: ExtendedClient
	extended.components.instance_id = InstanceId
	extended.components.instance = InstanceProtocol
	extended.components.instance_custom = InstanceCustom
	extended.components.instance_custom_handler = InstanceCustomHandler

	return extended
end

return {
	extend_server = extend_server,
	extend_client = extend_client,

	instance_id = InstanceId,
	instance = InstanceProtocol,
	instance_custom = InstanceCustom,
	instance_custom_handler = InstanceCustomHandler,
}
