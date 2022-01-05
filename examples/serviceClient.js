import { Node } from "nv";

class OddEvenCheckClient extends Node {
    async init() {
        await super.init();

        // You can wait for a service to be ready using the
        // `waitForServiceReady` method
        this.log.info("Waiting for service to be ready...");
        await this.waitForServiceReady("odd_even_check");

        this.log.info("Service ready!");

        // Call any service using the `call_service` method The service name is
        // the first argument, the next is an array of positional arguments, and
        // the final is an object of keyword arguments. Ensure the arguments
        // match what is expected by the service server!

        const result = await this.callService("odd_even_check", [5]);
        this.log.info(`Result: The number was ${result}`);
    }
}

// Create the node
const node = new OddEvenCheckClient({ nodeName: "odd_even_check_client_node" });
await node.init();
