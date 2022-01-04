import { Node } from "nv";

class Subscriber extends Node {
    subscriber_callback(msg) {
        this.log.info(`Received message: ${msg}`);
    }
}

// Create the node
const node = new Subscriber({ nodeName: "subscriber_node" });
await node.init();

// Subscribe to a topic
node.createSubscription("hello_world", node.subscriber_callback.bind(node));
