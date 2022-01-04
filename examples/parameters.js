import path from "path";
import { fileURLToPath } from "url";

import { Node } from "nv";

class ParameterExamples extends Node {
    async init() {
        await super.init();

        // Getting and setting single parameters is easy
        await this.setParameter("ping", "pong", {
            description: "This is a test parameter",
        });
        this.log.info(
            "Example parameter: " + (await this.getParameter("ping"))
        );

        // You can also set multiple parameters at once
        await this.setParameters([
            {
                name: "pong",
                value: "ping",
            },
            {
                name: "ding",
                value: "dong",
            },
        ]);
        this.log.info(
            "One of two parameters set together: " +
                (await this.getParameter("pong"))
        );
        this.log.info(
            "Two of two parameters set together: " +
                (await this.getParameter("ding"))
        );

        // If you try to get a parameter which doesn't exist, you'll get null
        this.log.info(
            "This parameter doesn't exist: " + (await this.getParameter("foo"))
        );

        // You can set and get subparameters with dot notation
        await this.setParameter("foo.bar", "baz");
        this.log.info("Subparameter: " + (await this.getParameter("foo.bar")));

        // By default, parameters are specific to each node, but it's easy to
        // get or set parameters from different nodes
        await this.setParameter(
            "example_parameter",
            "Hello from another node!",
            {
                nodeName: "node2",
            }
        );
        this.log.info(
            "Example parameter from another node: " +
                (await this.getParameter("example_parameter", {
                    nodeName: "node2",
                }))
        );

        // If you want to set loads of parameters, you can do this from a .json
        // file accessible from the node
        await this.setParametersFromFile(
            fileURLToPath(
                path.join(path.dirname(import.meta.url), "config.json")
            )
        );
        this.log.info(
            "Parameter from config.json: " +
                (await this.getParameter("param1", { nodeName: "node1" }))
        );

        // If you only want to load the parameters but not set them on the
        // parameter server, you can use `loadParametersFromFile`
        const parameters = await this.loadParametersFromFile(
            fileURLToPath(
                path.join(path.dirname(import.meta.url), "config.json")
            )
        );
        this.log.info(
            "Parameter from config.json: " + parameters["node1"]["param1"]
        );

        // You can get all parameters for a node with `getParameters`
        this.log.info(
            `All parameters for this node: ${JSON.stringify(
                await this.getParameters()
            )}`
        );

        // Finally you can remove parameters from the parameter server
        await this.deleteParameter("example_parameter");
        this.log.info(
            `Removed parameter: ${await this.getParameter("example_parameter")}`
        );

        // You can remove all parameters from a node at once
        await this.deleteParameters();
    }
}

// Create the node
const node = new ParameterExamples({ nodeName: "parameter_examples_node" });
node.init();
