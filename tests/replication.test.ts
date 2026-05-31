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

async function runServer(body: string) {
    const result = await server.runCode({
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

            local function spawnPart(name, parent)
                local part = Instance.new("Part")
                part.Name = name
                part.Anchored = true
                part.Parent = parent
                return part
            end

            local function spawnReplicatedInstanceEntityImperative(part)
                local e = world:entity()
                world:set(e, cts.Target, part)
                replicator:set_networked(e)
                replicator:set_instance(e, cts.Target)
                return e
            end

            local function spawnReplicatedInstanceEntityDeclarative(part)
                local e = world:entity()
                world:set(e, cts.Target, part)
                world:add(e, replecs.networked)
                world:add(e, Jecs.pair(replecs_roblox.instance, cts.Target))
                return e
            end

            local function findInstance(name)
                for e, inst in world:query(cts.Target) do
                    if typeof(inst) == "Instance" and inst.Name == name then
                        return e, inst
                    end
                end
                return nil
            end

            ${body}
        `,
    })

    return result.return
}

async function runClient(body: string) {
    const result = await client.runCode({
        target: "play:client",
        cacheRequires: true,
        source: /* lua */ `
            local ReplicatedStorage = game:GetService("ReplicatedStorage")

            local world = require(ReplicatedStorage.shared.world)
            local cts = require(ReplicatedStorage.shared.cts)

            local function findInstance(name)
                for e, inst in world:query(cts.Target) do
                    if typeof(inst) == "Instance" and inst.Name == name then
                        return e, inst
                    end
                end
                return nil
            end

            -- let replication happen, removing this causes some flaky tests
            task.wait(0.5)

            ${body}
        `,
    })

    return result.return
}

describe("imperative api", () => {
    test("reconciles an instance in a replicated container", async () => {
        await runServer(/* lua */ `
            spawnReplicatedInstanceEntityImperative(spawnPart("imperative_replicated", workspace))
        `)

        expect(await runClient(/* lua */ `
            return findInstance("imperative_replicated") ~= nil
        `)).toBe(true)
    })

    test("defers until the instance enters a replicated container", async () => {
        await runServer(/* lua */ `
            spawnReplicatedInstanceEntityImperative(spawnPart("imperative_deferred", ServerStorage))
        `)

        expect(await runClient(/* lua */ `
            return findInstance("imperative_deferred") ~= nil
        `)).toBe(false)

        await runServer(/* lua */ `
            ServerStorage.imperative_deferred.Parent = workspace
        `)

        expect(await runClient(/* lua */ `
            return findInstance("imperative_deferred") ~= nil
        `)).toBe(true)
    })

    test("stops replicating the instance when stopped", async () => {
        await runServer(/* lua */ `
            spawnReplicatedInstanceEntityImperative(spawnPart("imperative_stopped", workspace))
        `)

        expect(await runClient(/* lua */ `
            return findInstance("imperative_stopped") ~= nil
        `)).toBe(true)

        await runServer(/* lua */ `
            replicator:stop_instance(findInstance("imperative_stopped"), cts.Target)
        `)

        expect(await runClient(/* lua */ `
            return findInstance("imperative_stopped") ~= nil
        `)).toBe(false)
    })

    test("keeps the reconciled instance when stopped with keep", async () => {
        await runServer(/* lua */ `
            spawnReplicatedInstanceEntityImperative(spawnPart("imperative_kept", workspace))
        `)

        expect(await runClient(/* lua */ `
            return findInstance("imperative_kept") ~= nil
        `)).toBe(true)

        await runServer(/* lua */ `
            replicator:stop_instance(findInstance("imperative_kept"), cts.Target, true)
        `)

        expect(await runClient(/* lua */ `
            return findInstance("imperative_kept") ~= nil
        `)).toBe(true)
    })
})

describe("declarative api", () => {
    test("reconciles an instance in a replicated container", async () => {
        await runServer(/* lua */ `
            spawnReplicatedInstanceEntityDeclarative(spawnPart("component_replicated", workspace))
        `)

        expect(await runClient(/* lua */ `
            return findInstance("component_replicated") ~= nil
        `)).toBe(true)
    })

    test("defers until the instance enters a replicated container", async () => {
        await runServer(/* lua */ `
            spawnReplicatedInstanceEntityDeclarative(spawnPart("component_deferred", ServerStorage))
        `)

        expect(await runClient(/* lua */ `
            return findInstance("component_deferred") ~= nil
        `)).toBe(false)

        await runServer(/* lua */ `
            ServerStorage.component_deferred.Parent = workspace
        `)

        expect(await runClient(/* lua */ `
            return findInstance("component_deferred") ~= nil
        `)).toBe(true)
    })

    test("stops replicating the instance when stopped", async () => {
        await runServer(/* lua */ `
            spawnReplicatedInstanceEntityDeclarative(spawnPart("component_stopped", workspace))
        `)

        expect(await runClient(/* lua */ `
            return findInstance("component_stopped") ~= nil
        `)).toBe(true)

        await runServer(/* lua */ `
            world:remove(findInstance("component_stopped"), Jecs.pair(replecs_roblox.instance, cts.Target))
        `)

        expect(await runClient(/* lua */ `
            return findInstance("component_stopped") ~= nil
        `)).toBe(false)
    })
})

describe("streaming", () => {
    test("defers reconciliation until a streamed-out instance streams in", async () => {
        // 1. create a part far outside the player's streaming radius
        await runServer(/* lua */ `
            local part = spawnPart("streaming_part", workspace)
            part.Position = Vector3.new(50000, 0, 0)
        `)

        // 2-3. nothing is replicated yet, so streaming alone must keep it off the client
        expect(await runClient(/* lua */ `
            return workspace:FindFirstChild("streaming_part") ~= nil
        `)).toBe(false)

        // 4. replicate it through ecs while it is still streamed out
        await runServer(/* lua */ `
            spawnReplicatedInstanceEntityDeclarative(workspace.streaming_part)
        `)

        // 5-6. the entity replicates, but the instance is still streamed out — absent from
        // both the client workspace and the client entity (the reconciler can't resolve it)
        expect(await runClient(/* lua */ `
            return {
                inWorkspace = workspace:FindFirstChild("streaming_part") ~= nil,
                onEntity = findInstance("streaming_part") ~= nil,
            }
        `)).toEqual({ inWorkspace: false, onEntity: false })

        // 7. move it next to the player so it streams in
        await runServer(/* lua */ `
            local player = Players:GetPlayers()[1]
            local character = player.Character or player.CharacterAdded:Wait()
            local root = character:WaitForChild("HumanoidRootPart")
            workspace.streaming_part.Position = root.Position
        `)

        // 8-9. the tagged instance streams in and the reconciler resolves it onto the entity
        expect(await runClient(/* lua */ `
            return {
                inWorkspace = workspace:FindFirstChild("streaming_part") ~= nil,
                onEntity = findInstance("streaming_part") ~= nil,
            }
        `)).toEqual({ 
            inWorkspace: true, 
            onEntity: true 
        })
    })
})