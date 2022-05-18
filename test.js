const { Node } = require("./src/index");

class Subscriber extends Node {
    async init() {
        await super.init();

        this.message = null;
        this.createSubscription(
            "jest_test_topic",
            this.subscriberCallback.bind(this)
        );
    }

    subscriberCallback(msg) {
        this.message = msg;
    }
}

class ServiceServer extends Node {
    async init() {
        await super.init();

        this.createService("example_service", this.exampleService.bind(this));
        this.createService("list_service", this.listService.bind(this));
    }

    exampleService(arg, kwargs) {
        return arg + kwargs.kwarg;
    }

    listService() {
        return [1, 2, 3];
    }
}

jest.setTimeout(30000);

test("messaging", async () => {
    const subscriberNode = new Subscriber({
        nodeName: "subscriber_node",
        skipRegistration: true,
    });
    await subscriberNode.init();

    const publisherNode = new Node({
        nodeName: "publisher_node",
        skipRegistration: true,
    });
    await publisherNode.init();

    const testData = [
        "Hello World!",
        42,
        [1, 2, 3],
        { key: "value" },
        [...Array(100)].map((_) => Math.random()),
    ];

    currentIndex = 0;

    const sendTestData = () => {
        publisherNode.publish("jest_test_topic", testData[currentIndex]);
        currentIndex++;
    };

    const checkTestData = () => {
        expect(subscriberNode.message).toEqual(testData[currentIndex - 1]);
        if (currentIndex < testData.length) {
            sendTestData();
            setTimeout(checkTestData, 200);
        } else {
            subscriberNode.destroyNode();
            publisherNode.destroyNode();
        }
    };

    sendTestData();
    setTimeout(checkTestData, 200);
});
