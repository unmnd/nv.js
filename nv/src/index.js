/*
The `Node` class is the base class for all nodes in the network. It provides
methods for communicating between different nodes and the server, as well as
logging, parameter handling, and other things.

Callum Morrison, 2021
UNMND, Ltd. 2021
<callum@unmnd.com>

All Rights Reserved
*/

import winston from "winston";
import Redis from "ioredis";

import * as utils from "./utils.js";
import * as version from "./version.js";

export class Node {
    constructor({
        nodeName = null,
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
        `super().init(name)` in your new node.

        @param {String} name The name of the node.
        @param {Boolean} skipRegistration Whether to skip the registration of
            the node with the server. This should not be used for normal nodes, but
            is useful for commandline access.
        @param {String} logLevel The log level to use.
        @param {Boolean} keepOldParameters Whether to keep old parameters from
            previous instances of this node.
        */

        // Bind callbacks to gracefully exit the node on signal
        process.on("SIGINT", this._sigtermHandler.bind(this));
        process.on("SIGTERM", this._sigtermHandler.bind(this));

        // Generate a random node name if none is provided
        if (nodeName === null) {
            nodeName = utils.generateName();
        }

        // Initialise logger
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

        // Initialise parameters
        this.name = nodeName;
        this.nodeRegistered = false;
        this.skipRegistration = skipRegistration;
        this.stopped = false;
        this._startTime = Date.now() / 1000;

        // The subscriptions dictionary is in the form of:
        // {
        //   topic1: [callback1],
        //   topic2: [callback2, callback3],
        //   ...
        // }
        this._subscriptions = {};

        // The publishers dict tracks each topic which has been published on
        // in the past, and the unix timestamp of the last publish.
        this._publishers = {};

        // The services dictionary is used to keep track of exposed services, and
        // their unique topic names for calling.
        this._services = {};

        // The timeouts object is used to keep track of timers, where they can
        // all be stopped automatically at node termination.
        this.timeouts = {};
    }

    async init() {
        // Wait for the node condition to be met
        try {
            await this.nodeCondition();
        } catch (e) {
            this.log.error("Node condition failed, exiting");
            throw e;
        }

        this.log.debug(
            `Initialising ${this.name} using framework.js version nv ${version.__version__}`
        );

        // Connect redis clients
        const redisHost = process.env.NV_REDIS_HOST;
        const redisPort = process.env.NV_REDIS_PORT || 6379;

        this._redis = {};

        // The topics database stores messages for communication between nodes.
        // The key is always the topic.
        this._redis["sub"] = await this._connectRedis({
            host: redisHost,
            port: redisPort,
            db: 0,
        });

        // Handle received messages
        this._redis["sub"].on(
            "message",
            this._handleSubscriptionCallback.bind(this)
        );

        // There are two identical Redis instances, as ioredis does not allow
        // subscriptions on the same client as publishing.
        this._redis["pub"] = await this._connectRedis({
            host: redisHost,
            port: redisPort,
            db: 0,
        });

        // The parameters database stores key-value parameters to be used for
        // each node. The key is the node_name.parameter_name.
        this._redis["params"] = await this._connectRedis({
            host: redisHost,
            port: redisPort,
            db: 1,
        });

        // The transforms database stores transformations between frames. The key
        // is in the form <source_frame>:<target_frame>.
        this._redis["transforms"] = await this._connectRedis({
            host: redisHost,
            port: redisPort,
            db: 2,
        });

        // The nodes database stores up-to-date information about which nodes are
        // active on the network. Each node is responsible for storing and
        // keeping it's own information active.
        this._redis["nodes"] = await this._connectRedis({
            host: redisHost,
            port: redisPort,
            db: 3,
        });

        if (this.skipRegistration) {
            this.log.warning("Skipping node registration...");
        } else {
            // Check if the node exists
            if (await this._redis["nodes"].exists(this.name)) {
                this.log.info(
                    `Node ${this.name} already exists, waiting to see if it disappears...`
                );

                // Wait up to 10 seconds for the node to disappear
                let nodeExists = true;
                for (let i = 0; i < 10; i++) {
                    nodeExists = await this._redis["nodes"].exists(this.name);
                    if (!nodeExists) {
                        break;
                    }
                    await utils.sleep(1000);
                }

                if (nodeExists) {
                    throw new Error(`Node ${this.name} still exists`);
                }
            }

            // Register the node
            this.log.info(`Registering node ${this.name}`);

            await this._registerNode();

            // Remove residual parameters if required
            if (!this.keepOldParameters) {
                await this.deleteParameters({});
            }
        }
    }

    async _registerNode() {
        /*
        Register the node with the network.
        */

        const renewNodeInformation = async () => {
            if (!this.nodeRegistered || this.stopped) {
                return;
            }

            this._redis["nodes"].set(
                this.name,
                JSON.stringify(await this.getNodeInformation()),
                "EX",
                10
            );

            // Assigning the timer to a variable allows it to be cancelled
            // immediately on shutdown, instead of waiting up to 5 seconds for
            // the next loop.
            this.timeouts["renew_node_information"] = setTimeout(
                renewNodeInformation,
                5000
            );
        };

        // Register the node
        await this._redis["nodes"].set(
            this.name,
            JSON.stringify(this.getNodeInformation()),
            "EX",
            10
        );

        this.nodeRegistered = true;
        this.log.info(`Node ${this.name} registered`);

        // Renew the node information every 5 seconds
        renewNodeInformation();
    }

    _deregisterNode() {
        /*
        Deregister the node from the network.
        */

        this.nodeRegistered = false;
        this._redis["nodes"].del(this.name);

        this.log.info(`Node ${this.name} deregistered`);
    }

    async _connectRedis({ redisHost = "", port = 6379, db = 0 }) {
        /*
        Connect the Redis client to the database to allow messaging. It attempts
        to find the host automatically on either localhost, or connecting to a
        container named 'redis'.

        @param {String} redisHost The host of the redis server.
        @param {Number} port The port of the redis server.
        @param {Number} db The database to connect to.
        */

        const connect = async (options) => {
            this.log.info(
                `Connecting to redis server at ${options.host}:${options.port}`
            );
            const r = new Redis({ ...options, lazyConnect: true });

            try {
                await r.connect();

                this.log.info(
                    `Connected to Redis server at ${options.host}:${options.port}`
                );
                return r;
            } catch (e) {
                r.disconnect();

                this.log.error(
                    `Failed to connect to Redis server at ${options.host}:${options.port}`
                );
                this.log.error(e);

                return false;
            }
        };

        let r;

        // If the host is supplied, it should override any other auto-detection
        if (redisHost) {
            r = await connect({
                host: redisHost,
                port: port,
                db: db,
            });

            if (r) {
                return r;
            } else {
                throw new Error(
                    `Failed to connect to Redis server at ${redisHost}:${port}`
                );
            }
        }

        // Try to connect with the hostnames 'redis' and 'localhost'
        // automatically

        // First try 'redis'
        r = await connect({
            host: "redis",
            port: port,
            db: db,
        });

        if (r) {
            return r;
        }

        // Then try 'localhost'
        r = await connect({
            host: "localhost",
            port: port,
            db: db,
        });

        if (r) {
            return r;
        }

        // If all else fails, raise an error
        throw new Error(
            `Could not connect to Redis at redis:${port} or localhost:${port}`
        );
    }

    _decodePubSubMessage(message) {
        /*
        Decode a message from the network.

        @param message The message to decode.

        @returns The decoded message.
        */

        try {
            return JSON.parse(message);
        } catch (e) {
            return message;
        }
    }

    _encodePubSubMessage(message) {
        /*
        Encode a message to be sent to the network.

        @param message The message to encode.

        @returns The encoded message.
        */

        try {
            return JSON.stringify(message);
        } catch (e) {
            return message;
        }
    }

    _handleSubscriptionCallback(channel, message) {
        /*
        Handle a message received from the network.

        @param channel The channel the message was received on.
        @param message The message received.
        */

        const callbacks = this._subscriptions[channel];

        if (callbacks) {
            callbacks.forEach((callback) => {
                callback(message);
            });
        }
    }

    _sigtermHandler() {
        /*
        Handle termination signals to gracefully stop the node.
        */

        this.log.info("Received program termination signal; exiting...");
        this.destroyNode();
    }

    async nodeCondition() {
        /*
        This function is called before any further node setup. It is used to
        determine whether the node should be started or not.

        It can be used to stop node creation until a desired condition is met,
        for example that a device is connected.

        When overwriting this function in a node, it should not depend on any
        other node functions, as they will not be initialised yet.

        @returns {Promise} A promise which resolves when the node condition is
            met.
        */
        return Promise.resolve();
    }

    getLogger() {
        /*
        Get the logger for this node.

        @returns The logger for this node.
        */

        return this.log;
    }

    getName() {
        /*
        Get the name of this node.

        @returns {String} The name of this node.
        */

        return this.name;
    }

    destroyNode() {
        /*
        Destroy the node.

        This will remove the node from the network and stop the node.
        */

        this.log.info(`Destroying node ${this.name}`);

        // Remove the node from the list of nodes
        this._deregisterNode();

        // Stop any timers or services running
        this.stopped = true;
        for (const [key, t] of Object.entries(this.timeouts)) {
            this.log.debug(`Cancelling timeout: ${key}`);
            clearTimeout(t);
        }

        // Terminate all redis instances
        for (const [key, r] of Object.entries(this._redis)) {
            this.log.debug(`Closing redis instance: ${key}`);
            r.disconnect();
        }
    }

    async checkNodeExists(nodeName) {
        /*
        Check if a node with the given name exists.

        @param {String} nodeName The name of the node to check.

        @return {Promise} A promise which resolves to true if the node exists,
        or false if it does not.
        */
        return this._redis["nodes"].exists(nodeName);
    }

    async getNodeInformation(nodeName = null) {
        /*
        ### Return the node information dictionary.

        If a node name is provided, the information for that node is returned.
        If no node name is provided, the information for the current node is
        returned.

        @param {String} nodeName The name of the node to get information for.

        @return {Object} The node information dictionary.
        */

        if (nodeName === null) {
            return {
                time_registered: this._startTime,
                time_modified: Date.now() / 1000,
                version: version.__version__ + "-js",
                subscriptions: Object.keys(this._subscriptions),
                publishers: this._publishers,
                services: this._services,
            };
        } else {
            return JSON.parse(await this._redis["nodes"].get(nodeName));
        }
    }

    async deleteParameters({ names = null, nodeName = null }) {
        /*
        ### Delete multiple parameter values on the parameter server at once.

        Supplying no arguments will delete all parameters on the current node.
        Supplying only parameter names will use the current node.

        @param {Array} names An array of parameter names to delete. If not
        specified, all parameters on the selected node will be deleted. @param
        {String} nodeName The name of the node to delete parameters on. If not
        specified, the current node will be used.

        @return {Promise} A promise which resolves when all the parameters have
        been deleted.
        */

        if (!nodeName) {
            nodeName = this.name;
        }

        // Create a pipe to send all updates at once
        const pipe = this._redis["params"].pipeline();

        // If no names are specified, delete all parameters on the node
        if (names === null) {
            // Get all parameters on the node
            names = await this._redis["params"].keys(`${nodeName}.*`);
        } else {
            // Append the node name to each parameter name
            names = names.map((name) => `${nodeName}.${name}`);
        }

        // Delete each parameter
        names.forEach((name) => pipe.del(name));

        // Execute the pipe
        return pipe.exec();
    }

    createSubscription(channel, callback) {
        /*
        ### Create a subscription.

        @param {String} channel The channel to subscribe to.
        @param {Function} callback The callback to call when a message is
        received.
        */

        // Add the callback to the list of callbacks for the channel
        if (!this._subscriptions[channel]) {
            this._subscriptions[channel] = [];
        }

        this._subscriptions[channel].push(callback);

        // Subscribe to the channel
        this._redis["sub"].subscribe(channel);
    }

    publish(channel, message) {
        /*
        ### Publish a message to a channel.

        @param {String} channel The channel to publish to.
        @param {Object} message The message to publish.
        */

        // Update the publishers object
        this._publishers[channel] = Date.now() / 1000;

        // Encode the message
        message = this._encodePubSubMessage(message);

        // Publish the message
        this._redis["pub"].publish(channel, message);
    }
}
