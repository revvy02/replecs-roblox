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
            local replicator = require(game:GetService("ServerScriptService").server.replicator)
            local world = require(game.ReplicatedStorage.shared.world)
            local cts = require(game.ReplicatedStorage.shared.cts)
            local Jecs = require(game.ReplicatedStorage.packages.jecs)
            ${body}
        `,
    })
}

function runClient(body: string) {
    return client.runCode({
        target: "play:client",
        cacheRequires: true,
        showReturn: true,
        source: /* lua */ `
            local world = require(game.ReplicatedStorage.shared.world)
            local cts = require(game.ReplicatedStorage.shared.cts)
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
            task.wait(1)
            for _, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "imperative_replicated" then
                    return true
                end
            end
            return false
        `)

        expect(result.output).toContain("true")
    })

    test("defers until the instance enters a replicated container", async () => {
        await runServer(/* lua */ `
            local part = Instance.new("Part")
            part.Name = "imperative_deferred"
            part.Anchored = true
            part.Parent = game:GetService("ServerStorage")

            local e = world:entity()
            world:set(e, cts.Target, part)
            replicator:set_networked(e)
            replicator:set_instance(e, cts.Target)
        `)

        const before = await runClient(/* lua */ `
            task.wait(1)
            for _, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "imperative_deferred" then
                    return true
                end
            end
            return false
        `)

        expect(before.output).toContain("false")

        await runServer(/* lua */ `
            game:GetService("ServerStorage"):FindFirstChild("imperative_deferred").Parent = workspace
        `)

        const after = await runClient(/* lua */ `
            task.wait(1)
            for _, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "imperative_deferred" then
                    return true
                end
            end
            return false
        `)

        expect(after.output).toContain("true")
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
            task.wait(1)
            for _, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "imperative_stopped" then
                    return true
                end
            end
            return false
        `)

        expect(before.output).toContain("true")

        await runServer(/* lua */ `
            for e, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "imperative_stopped" then
                    replicator:stop_instance(e, cts.Target)
                    break
                end
            end
        `)

        const after = await runClient(/* lua */ `
            task.wait(1)
            for _, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "imperative_stopped" then
                    return true
                end
            end
            return false
        `)

        expect(after.output).toContain("false")
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
            replicator:set_networked(e)
            world:add(e, Jecs.pair(replicator.components.instance, cts.Target))
        `)

        const result = await runClient(/* lua */ `
            task.wait(1)
            for _, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "component_replicated" then
                    return true
                end
            end
            return false
        `)

        expect(result.output).toContain("true")
    })

    test("defers until the instance enters a replicated container", async () => {
        await runServer(/* lua */ `
            local part = Instance.new("Part")
            part.Name = "component_deferred"
            part.Anchored = true
            part.Parent = game:GetService("ServerStorage")

            local e = world:entity()
            world:set(e, cts.Target, part)
            replicator:set_networked(e)
            world:add(e, Jecs.pair(replicator.components.instance, cts.Target))
        `)

        const before = await runClient(/* lua */ `
            task.wait(1)
            for _, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "component_deferred" then
                    return true
                end
            end
            return false
        `)

        expect(before.output).toContain("false")

        await runServer(/* lua */ `
            game:GetService("ServerStorage"):FindFirstChild("component_deferred").Parent = workspace
        `)

        const after = await runClient(/* lua */ `
            task.wait(1)
            for _, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "component_deferred" then
                    return true
                end
            end
            return false
        `)

        expect(after.output).toContain("true")
    })

    test("stops replicating the instance when stopped", async () => {
        await runServer(/* lua */ `
            local part = Instance.new("Part")
            part.Name = "component_stopped"
            part.Anchored = true
            part.Parent = workspace

            local e = world:entity()
            world:set(e, cts.Target, part)
            replicator:set_networked(e)
            world:add(e, Jecs.pair(replicator.components.instance, cts.Target))
        `)

        const before = await runClient(/* lua */ `
            task.wait(1)
            for _, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "component_stopped" then
                    return true
                end
            end
            return false
        `)

        expect(before.output).toContain("true")

        await runServer(/* lua */ `
            for e, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "component_stopped" then
                    world:remove(e, Jecs.pair(replicator.components.instance, cts.Target))
                    break
                end
            end
        `)

        const after = await runClient(/* lua */ `
            task.wait(1)
            for _, inst in world:query(cts.Target) do
                if typeof(inst) == "Instance" and inst.Name == "component_stopped" then
                    return true
                end
            end
            return false
        `)

        expect(after.output).toContain("false")
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
        task.wait(1)
        for _, health in world:query(cts.Health) do
            if health == 100 then
                return health
            end
        end
        return false
    `)

    expect(result.output).toContain("100")
})
