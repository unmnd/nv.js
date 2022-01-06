const { Node } = require("../nv/src/index");

class Subscriber extends Node {
    async init() {
        await super.init();

        // Subscribe to a topic
        node.createSubscription(
            "hello_world",
            node.subscriber_callback.bind(node)
        );
    }

    subscriber_callback(msg) {
        this.log.info(`Received message: ${msg}`);
    }
}

// Create the node
const node = new Subscriber({ nodeName: "subscriber_node" });
node.init();
