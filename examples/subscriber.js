const { Node } = require("../nv/src/index");

class Subscriber extends Node {
    async init() {
        await super.init();

        // Subscribe to a topic
        this.createSubscription(
            "hello_world",
            this.subscriber_callback.bind(this)
        );
    }

    subscriber_callback(msg) {
        this.log.info(`Received message: ${msg}`);
    }
}

// Create the node
const node = new Subscriber({ nodeName: "subscriber_node" });
node.init();
