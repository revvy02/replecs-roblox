import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { RodeoClient, type MultiplayerTestServer, type MultiplayerTestClient } from "@rodeo/client";

const PORT = 45872;
const PLACE = "place.rbxl";

let serve: ReturnType<typeof Bun.spawn> | undefined;
let session: RodeoClient;
let server: MultiplayerTestServer;
let client: MultiplayerTestClient;

beforeAll(async () => {
    Bun.spawnSync(["rojo", "build", "tests/fixture/test.project.json", "-o", PLACE], {
        stdout: "inherit",
        stderr: "inherit",
    });

    serve = Bun.spawn(["rodeo", "serve", "--port", String(PORT), "--ppid", String(process.pid)], {
        stdout: "ignore",
        stderr: "ignore",
    });

    session = await RodeoClient.connect(`localhost:${PORT}`);
    server = await (await session.getLocalStudio()).startMultiplayerTest({ placeFile: resolve(PLACE) });
    client = await server.connectClient();
}, 30_000)

afterAll(async () => {
    await client.disconnect();
    await server.close();
    await session.close();
    serve?.kill();
}, 30_000)

function runServer(body: string) {
    return server.runCode({
        target: "play:server",
        cacheRequires: true,
        source: /* lua */ `
            local ReplicatedStorage = game:GetService("ReplicatedStorage")
            local ServerScriptService = game:GetService("ServerScriptService")
            local ServerStorage = game:GetService("ServerStorage")
            local Players = game:GetService("Players")

            local replicator = require(ServerScriptService.server.replicator)
            local world = require(ReplicatedStorage.shared.world)
            local cts = require(ReplicatedStorage.shared.cts)
            local Jecs = require(ReplicatedStorage.packages.jecs)
            local replecs = require(ReplicatedStorage.packages.replecs)
            local replecs_roblox = require(ReplicatedStorage.packages.replecs_roblox)
            ${body}
        `,
    })
}

function runClient(body: string) {
    return client.runCode({
        target: "play:client",
        cacheRequires: true,
        source: /* lua */ `
            local ReplicatedStorage = game:GetService("ReplicatedStorage")

            local world = require(ReplicatedStorage.shared.world)
            local cts = require(ReplicatedStorage.shared.cts)

            local function findAnyInstanceComponent(name)
                for _, inst in world:query(cts.Target) do
                    if typeof(inst) == "Instance" and inst.Name == name then
                        return inst
                    end
                end
                return nil
            end

            ${body}
        `,
    })
}

describe("imperative api", () => {
    test("reconciles an instance in a replicated container", async () => {
        await runServer(/* lua */ `
            local part = Instance.new("Part")
            part.Name = "imperative_replicated"
            part.Anchored = true
            part.Parent = workspace

            local e = world:entity()
            world:set(e, cts.Target, part)
            replicator:set_networked(e)
            replicator:set_instance(e, cts.Target)
        `)

        const result = await runClient(/* lua */ `
            return findAnyInstanceComponent("imperative_replicated") ~= nil
        `)

        expect(result.return).toBe(true)
    })

    test("defers until the instance enters a replicated container", async () => {
        await runServer(/* lua */ `
            local part = Instance.new("Part")
            part.Name = "imperative_deferred"
            part.Anchored = true
            part.Parent = ServerStorage

            local e = world:entity()
            world:set(e, cts.Target, part)
            replicator:set_networked(e)
            replicator:set_instance(e, cts.Target)
        `)

        const before = await runClient(/* lua */ `
            return findAnyInstanceComponent("imperative_deferred") ~= nil
        `)

        expect(before.return).toBe(false)

        await runServer(/* lua */ `
            ServerStorage.imperative_deferred.Parent = workspace
        `)

        const after = await runClient(/* lua */ `
            return findAnyInstanceComponent("imperative_deferred") ~= nil
        `)

        expect(after.return).toBe(true)
    })

    test("stops replicating the instance when stopped", async () => {
        await runServer(/* lua */ `
            local part = Instance.new("Part")
            part.Name = "imperative_stopped"
            part.Anchored = true
            part.Parent = workspace

            local e = world:entity()
            world:set(e, cts.Target, part)
            replicator:set_networked(e)
            replicator:set_instance(e, cts.Target)
        `)

        const before = await runClient(/* lua */ `
            return findAnyInstanceComponent("imperative_stopped") ~= nil
        `)

        expect(before.return).toBe(true)

        await runServer(/* lua */ `
            for e, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "imperative_stopped" then
                    replicator:stop_instance(e, cts.Target)
                    break
                end
            end
        `)

        const after = await runClient(/* lua */ `
            return findAnyInstanceComponent("imperative_stopped") ~= nil
        `)

        expect(after.return).toBe(false)
    })

    test("keeps the reconciled instance when stopped with keep", async () => {
        await runServer(/* lua */ `
            local part = Instance.new("Part")
            part.Name = "imperative_kept"
            part.Anchored = true
            part.Parent = workspace

            local e = world:entity()
            world:set(e, cts.Target, part)
            replicator:set_networked(e)
            replicator:set_instance(e, cts.Target)
        `)

        const before = await runClient(/* lua */ `
            return findAnyInstanceComponent("imperative_kept") ~= nil
        `)

        expect(before.return).toBe(true)

        await runServer(/* lua */ `
            for e, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "imperative_kept" then
                    replicator:stop_instance(e, cts.Target, true)
                    break
                end
            end
        `)

        const after = await runClient(/* lua */ `
            return findAnyInstanceComponent("imperative_kept") ~= nil
        `)

        expect(after.return).toBe(true)
    })
})

describe("component api", () => {
    test("reconciles an instance in a replicated container", async () => {
        await runServer(/* lua */ `
            local part = Instance.new("Part")
            part.Name = "component_replicated"
            part.Anchored = true
            part.Parent = workspace

            local e = world:entity()
            world:set(e, cts.Target, part)
            world:add(e, replecs.networked)
            world:add(e, Jecs.pair(replecs_roblox.instance, cts.Target))
        `)

        const result = await runClient(/* lua */ `
            return findAnyInstanceComponent("component_replicated") ~= nil
        `)

        expect(result.return).toBe(true)
    })

    test("defers until the instance enters a replicated container", async () => {
        await runServer(/* lua */ `
            local part = Instance.new("Part")
            part.Name = "component_deferred"
            part.Anchored = true
            part.Parent = ServerStorage

            local e = world:entity()
            world:set(e, cts.Target, part)
            world:add(e, replecs.networked)
            world:add(e, Jecs.pair(replecs_roblox.instance, cts.Target))
        `)

        const before = await runClient(/* lua */ `
            return findAnyInstanceComponent("component_deferred") ~= nil
        `)

        expect(before.return).toBe(false)

        await runServer(/* lua */ `
            ServerStorage.component_deferred.Parent = workspace
        `)

        const after = await runClient(/* lua */ `
            return findAnyInstanceComponent("component_deferred") ~= nil
        `)

        expect(after.return).toBe(true)
    })

    test("stops replicating the instance when stopped", async () => {
        await runServer(/* lua */ `
            local part = Instance.new("Part")
            part.Name = "component_stopped"
            part.Anchored = true
            part.Parent = workspace

            local e = world:entity()
            world:set(e, cts.Target, part)
            world:add(e, replecs.networked)
            world:add(e, Jecs.pair(replecs_roblox.instance, cts.Target))
        `)

        const before = await runClient(/* lua */ `
            return findAnyInstanceComponent("component_stopped") ~= nil
        `)

        expect(before.return).toBe(true)

        await runServer(/* lua */ `
            for e, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "component_stopped" then
                    world:remove(e, Jecs.pair(replecs_roblox.instance, cts.Target))
                    break
                end
            end
        `)

        const after = await runClient(/* lua */ `
            return findAnyInstanceComponent("component_stopped") ~= nil
        `)

        expect(after.return).toBe(false)
    })
})

describe("streaming", () => {
    test("defers reconciliation until a streamed-out instance streams in", async () => {
        // 1. create a part far outside the player's streaming radius
        await runServer(/* lua */ `
            local part = Instance.new("Part")
            part.Name = "streaming_part"
            part.Anchored = true
            part.Position = Vector3.new(50000, 0, 0)
            part.Parent = workspace
        `)

        // 2-3. nothing is replicated yet, so streaming alone must keep it off the client
        const unstreamed = await runClient(/* lua */ `
            return workspace:FindFirstChild("streaming_part") ~= nil
        `)

        expect(unstreamed.return).toBe(false)

        // 4. replicate it through ecs while it is still streamed out
        await runServer(/* lua */ `
            local part = workspace.streaming_part
            local e = world:entity()
            world:set(e, cts.Target, part)
            world:add(e, replecs.networked)
            world:add(e, Jecs.pair(replecs_roblox.instance, cts.Target))
        `)

        // 5-6. the entity replicates, but the instance is still streamed out — absent from
        // both the client workspace and the client entity (the reconciler can't resolve it)
        const deferred = await runClient(/* lua */ `
            return {
                inWorkspace = workspace:FindFirstChild("streaming_part") ~= nil,
                onEntity = findAnyInstanceComponent("streaming_part") ~= nil,
            }
        `)

        expect(deferred.return).toEqual({ inWorkspace: false, onEntity: false })

        // 7. move it next to the player so it streams in
        await runServer(/* lua */ `
            local player = Players:GetPlayers()[1]
            local character = player.Character or player.CharacterAdded:Wait()
            local root = character:WaitForChild("HumanoidRootPart")
            workspace.streaming_part.Position = root.Position
        `)

        // 8-9. the tagged instance streams in and the reconciler resolves it onto the entity
        const streamed = await runClient(/* lua */ `
            return {
                inWorkspace = workspace:FindFirstChild("streaming_part") ~= nil,
                onEntity = findAnyInstanceComponent("streaming_part") ~= nil,
            }
        `)

        expect(streamed.return).toEqual({ inWorkspace: true, onEntity: true })
    })
})

test("replicates a plain value component through the fixture", async () => {
    await runServer(/* lua */ `
        local e = world:entity()
        world:set(e, cts.Health, 100)
        replicator:set_networked(e)
        replicator:set_reliable(e, cts.Health)
    `)

    const result = await runClient(/* lua */ `
        for _, health in world:query(cts.Health) do
            if health == 100 then
                return health
            end
        end
        return false
    `)

    expect(result.return).toBe(100)
})
