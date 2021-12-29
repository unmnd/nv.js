/*
The `Node` class is the base class for all nodes in the network. It provides
methods for communicating between different nodes and the server, as well as
logging, parameter handling, and other things.

Callum Morrison, 2021
UNMND, Ltd. 2021
<callum@unmnd.com>

All Rights Reserved
*/

import * as utils from "./utils.js";
import winston from "winston";

export class Node {
    constructor({
        nodeName = "",
        skipRegistration = false,
        logLevel = null,
        keepOldParameters = false,
    }) {
        /*
        The Node class is the main class of the nv framework. It is used to
        handle all interaction with the framework, including initialisation of
        nodes, subscribing to topics, publishing to topics, and creating timers.

        It is designed to be relatively compatible with the ROS framework,
        although some simplifications and improvements have been made where
        applicable.

        Initialise a new node by inheriting this class. Ensure you call
        `super().constructor(name)` in your new node.

        @param {String} name The name of the node.
        @param {Boolean} skipRegistration Whether to skip the registration of
            the node with the server. This should not be used for normal nodes, but
            is useful for commandline access.
        @param {String} logLevel The log level to use.
        @param {Boolean} keepOldParameters Whether to keep old parameters from
            previous instances of this node.
        */

        // Setup node name
        if (nodeName === "") {
            this.nodeName = utils.generateName();
            console.info("Generated node name: " + this.nodeName);
        } else {
            this.nodeName = nodeName;
        }

        // Setup logger
        this.log = winston.createLogger({
            level: logLevel || "debug",
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.colorize(),
                winston.format.json(),
                winston.format.printf((info) => {
                    return `${info.timestamp} ${info.level}: ${info.message}`;
                })
            ),
            transports: [new winston.transports.Console()],
        });

        // // Check if the node should be started by calling this.nodeCondition()
        // while (!this.nodeCondition()) {
        //     this.log.info("Node condition not met, waiting...");
        // }

    }
}
