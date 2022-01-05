import { Node } from "nv";

class OddEvenCheckClient extends Node {
    async init() {
        await super.init();

        // You can wait for a service to be ready using the
        // `waitForServiceReady` method
        this.log.info("Waiting for service to be ready...");
        await this.waitForServiceReady("odd_even_check")

        this.log.info("Service ready!");
    }
}

// Create the node
const node = new OddEvenCheckClient({ nodeName: "odd_even_check_client_node" });
await node.init();
