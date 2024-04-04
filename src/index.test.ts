import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "events";

import { Node } from "./index";

class Subscriber extends Node {
    private emitter = new EventEmitter();

    async init() {
        await super.init();

        this.createSubscription("test_topic", (msg) => {
            this.emitter.emit("message", msg);
        });
    }

    onMessage(callback: (msg: unknown) => void) {
        this.emitter.on("message", callback);
    }
}

class Publisher extends Node {
    async init() {
        await super.init();
    }
}

describe("messaging", async () => {
    let subscriberNode: Subscriber;
    let publisherNode: Publisher;

    beforeEach(async () => {
        subscriberNode = new Subscriber({
            nodeName: "subscriber_node",
            skipRegistration: true,
        });
        await subscriberNode.init();

        publisherNode = new Publisher({
            nodeName: "publisher_node",
            skipRegistration: true,
        });
        await publisherNode.init();
    });

    afterEach(async () => {
        subscriberNode.destroyNode();
        publisherNode.destroyNode();
    });

    test("string", async () => {
        publisherNode.publish("test_topic", "Hello World!");
        subscriberNode.onMessage((msg) => {
            expect(msg).toEqual("Hello World!");
        });
    });

    test("number", async () => {
        publisherNode.publish("test_topic", 42);
        subscriberNode.onMessage((msg) => {
            expect(msg).toEqual(42);
        });
    });

    test("array", async () => {
        publisherNode.publish("test_topic", [1, 2, 3]);
        subscriberNode.onMessage((msg) => {
            expect(msg).toEqual([1, 2, 3]);
        });
    });

    test("object", async () => {
        publisherNode.publish("test_topic", { key: "value" });
        subscriberNode.onMessage((msg) => {
            expect(msg).toEqual({ key: "value" });
        });
    });

    test("buffer", async () => {
        // Generate a random buffer of 100 bytes
        const buffer = Buffer.alloc(100);
        publisherNode.publish("test_topic", buffer);
        subscriberNode.onMessage((msg) => {
            expect(msg).toEqual(buffer);
        });
    });

    test("big buffer", async () => {
        const buffer = Buffer.alloc(1_000_000);
        publisherNode.publish("test_topic", buffer);
        subscriberNode.onMessage((msg) => {
            expect(msg).toEqual(buffer);
        });
    });
});

class ServiceServer extends Node {
    async init() {
        await super.init();

        this.createService("example_service", (args, kwargs) => {
            return {
                args: args,
                kwargs: kwargs,
            };
        });

        this.createService("list_service", () => {
            return [1, 2, 3];
        });
    }
}

class ServiceClient extends Node {
    async init() {
        await super.init();
    }
}

describe("services", async () => {
    let serviceServer: ServiceServer;
    let serviceClient: ServiceClient;

    beforeEach(async () => {
        serviceServer = new ServiceServer({
            nodeName: "service_server",
        });
        await serviceServer.init();

        serviceClient = new ServiceClient({
            nodeName: "service_client",
        });
        await serviceClient.init();
    });

    afterEach(async () => {
        serviceServer.destroyNode();
        serviceClient.destroyNode();
    });

    test("simple service", async () => {
        await serviceClient.waitForServiceReady("example_service");
        const result = await serviceClient.callService("example_service", {
            args: [1, 2, 3],
            kwargs: {
                key: "value",
            },
        });
        expect(result).toEqual({
            args: [1, 2, 3],
            kwargs: { key: "value" },
        });
    });

    test("simple list service", async () => {
        await serviceClient.waitForServiceReady("list_service");
        const result = await serviceClient.callService("list_service");
        expect(result).toEqual([1, 2, 3]);
    });
});
