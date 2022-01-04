import { Node } from "nv";

class Publisher extends Node {
    async init() {
        await super.init();

        this.counter = 0;

        // Start publisher loop running to continuously publish messages
        this.publish_hello_world();

        // Alternatively, publish at any time
        this.publish("another_topic", [
            "Anything",
            "you",
            "want",
            "to",
            "publish",
        ]);
    }

    publish_hello_world() {
        this.publish("hello_world", "Hello World! " + this.counter++);

        // Add timeouts to the `timeouts` object, and they will be automatically
        // stopped on node termination.
        this.timeouts["publish_hello_world"] = setTimeout(() => {
            this.publish_hello_world();
        }, 1000);
    }
}

// Create the node
const node = new Publisher({ nodeName: "publisher_node" });
node.init();
