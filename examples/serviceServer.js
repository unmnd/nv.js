const { Node } = require("../nv/src/index");

class OddEvenCheckServer extends Node {
    async init() {
        await super.init();

        // The `create_service` method creates a service server.
        // The first argument is the name of the service.
        // The second argument is the callback function that will be called when
        // a client calls the service.
        this.srv = this.createService(
            "odd_even_check",
            this.determineOddEven.bind(this)
        );
    }

    determineOddEven(number) {
        // The arguments supplied can be any number of positional or keyword
        // arguments. Just make sure the node calling the service has the same
        // arguments!

        // This service allows the number to be supplied as a positional
        // argument or keyword argument
        if (typeof number === "object") {
            number = number.number;
        }

        this.log.info(`Request received: ${number}`);

        // The response can be any common data type, and is sent using the
        // return keyword
        if (number % 2 === 0) {
            return "even";
        } else if (number % 2 === 1) {
            return "odd";
        } else {
            throw new Error("Invalid number");
        }
    }
}

// Create the node
const node = new OddEvenCheckServer({ nodeName: "odd_even_check_server_node" });
node.init();
