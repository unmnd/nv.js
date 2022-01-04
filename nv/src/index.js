/*
The `Node` class is the base class for all nodes in the network. It provides
methods for communicating between different nodes and the server, as well as
logging, parameter handling, and other things.

Callum Morrison, 2021
UNMND, Ltd. 2021
<callum@unmnd.com>

All Rights Reserved
*/

import { promises as fs } from "fs";

import winston from "winston";
import Redis from "ioredis";

import * as utils from "./utils.js";
import * as version from "./version.js";

export class Node {
    /**
     * The Node class is the main class of the nv framework. It is used to
     * handle all interaction with the framework, including initialisation of
     * nodes, subscribing to topics, publishing to topics, and creating timers.
     *
     * It is designed to be relatively compatible with the ROS framework,
     * although some simplifications and improvements have been made where
     * applicable.
     *
     * Initialise a new node by inheriting this class. Ensure you call
     * `super().init(name)` in your new node.
     *
     * @param {String} [name] The name of the node.
     * @param {Boolean} [skipRegistration] Whether to skip the registration of
     *     the node with the server. This should not be used for normal nodes, but
     *     is useful for commandline access.
     * @param {String} [logLevel] The log level to use.
     * @param {Boolean} [keepOldParameters] Whether to keep old parameters from
     *     previous instances of this node.
     */
    constructor({
        nodeName = null,
        skipRegistration = false,
        logLevel = null,
        keepOldParameters = false,
    }) {
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

    /**
     * Initialise the node. This should be called immediately after
     * inheriting the Node class.
     */
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
        this._redis["sub"] = await this._connectRedis(redisHost, {
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
        this._redis["pub"] = await this._connectRedis(redisHost, {
            port: redisPort,
            db: 0,
        });

        // The parameters database stores key-value parameters to be used for
        // each node. The key is the node_name.parameter_name.
        this._redis["params"] = await this._connectRedis(redisHost, {
            port: redisPort,
            db: 1,
        });

        // The transforms database stores transformations between frames. The key
        // is in the form <source_frame>:<target_frame>.
        this._redis["transforms"] = await this._connectRedis(redisHost, {
            port: redisPort,
            db: 2,
        });

        // The nodes database stores up-to-date information about which nodes are
        // active on the network. Each node is responsible for storing and
        // keeping it's own information active.
        this._redis["nodes"] = await this._connectRedis(redisHost, {
            port: redisPort,
            db: 3,
        });

        if (this.skipRegistration) {
            this.log.warn("Skipping node registration...");
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

    /**
     * Register the node with the network.
     */
    async _registerNode() {
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

    /**
     * Deregister the node from the network.
     */
    _deregisterNode() {
        this.nodeRegistered = false;
        this._redis["nodes"].del(this.name);

        this.log.info(`Node ${this.name} deregistered`);
    }

    /**
     * Connect the Redis client to the database to allow messaging. It attempts
     * to find the host automatically on either localhost, or connecting to a
     * container named 'redis'.
     *
     * @param {String} redisHost The host of the redis server.
     * @param {Number} [port] The port of the redis server.
     * @param {Number} [db] The database to connect to.
     *
     * @returns {Promise<RedisClient>} The connected Redis client.
     */
    async _connectRedis(redisHost, { port = 6379, db = 0 }) {
        const connect = async (options) => {
            this.log.debug(
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

                this.log.debug(
                    `Failed to connect to Redis server at ${options.host}:${options.port}\n${e}`
                );

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

    /**
     * Decode a message from the network.
     *
     * @param {*} message The message to decode.
     *
     * @returns The decoded message.
     */
    _decodePubSubMessage(message) {
        try {
            return JSON.parse(message);
        } catch (e) {
            return message;
        }
    }

    /**
     * Encode a message to be sent to the network.
     *
     * @param {*} message The message to encode.
     *
     * @returns The encoded message.
     */
    _encodePubSubMessage(message) {
        try {
            return JSON.stringify(message);
        } catch (e) {
            return message;
        }
    }

    /**
     * Handle a message received from the network.
     *
     * @param channel The channel the message was received on.
     * @param message The message received.
     */
    _handleSubscriptionCallback(channel, message) {
        const callbacks = this._subscriptions[channel];

        if (callbacks) {
            callbacks.forEach((callback) => {
                callback(message);
            });
        }
    }

    /**
     * Handle termination signals to gracefully stop the node.
     */
    _sigtermHandler() {
        this.log.info("Received program termination signal; exiting...");
        this.destroyNode();
    }

    /**
     * This function is called before any further node setup. It is used to
     * determine whether the node should be started or not.
     *
     * It can be used to stop node creation until a desired condition is met,
     * for example that a device is connected.
     *
     * When overwriting this function in a node, it should not depend on any
     * other node functions, as they will not be initialised yet.
     *
     * @returns {Promise} A promise which resolves when the node condition is
     *     met.
     */
    async nodeCondition() {
        return Promise.resolve();
    }

    /**
     * Get the logger for this node.
     *
     * @returns The logger for this node.
     */
    getLogger() {
        return this.log;
    }

    /**
     * Get the name of this node.
     *
     * @returns {String} The name of this node.
     */
    getName() {
        return this.name;
    }

    /**
     * Destroy the node.
     *
     * This will remove the node from the network and stop the node.
     */
    destroyNode() {
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

    /**
     * Return the node information dictionary.
     *
     * If a node name is provided, the information for that node is returned. If
     * no node name is provided, the information for the current node is
     * returned.
     *
     * @param {String} [nodeName] The name of the node to get
     * information for.
     *
     * @return {Object} The node information dictionary.
     */
    async getNodeInformation({ nodeName = null } = {}) {
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

    /**
     * Get all nodes present in the network.
     *
     * @returns {Object} A dictionary of node information.
     */
    async getNodes() {
        const nodeNames = await this.getNodesList();

        const nodes = {};

        for (const nodeName of nodeNames) {
            nodes[nodeName] = await this.getNodeInformation(nodeName);
        }

        return nodes;
    }

    /**
     * Get a list of all nodes present in the network.
     *
     * @returns {Array} A list of node names.
     */
    async getNodesList() {
        return await this._redis["nodes"].keys("*");
    }

    /**
     * Check if a node with the given name exists.
     *
     * @param {String} nodeName The name of the node to check.
     *
     * @return {Promise} A promise which resolves to true if the node exists,
     * or false if it does not.
     */
    async checkNodeExists(nodeName) {
        return this._redis["nodes"].exists(nodeName);
    }

    /**
     * Get all topics present in the network.
     *
     * @returns {Object} A dictionary containing all topics on the network, and
     * the time of their most recent message.
     */
    async getTopics() {
        const topics = {};

        const nodes = await this.getNodes();

        // Loop over each node and add their publishers to the list. If the topic
        // already exists, the most recent publish time is used.
        for (const nodeName in nodes) {
            const node = nodes[nodeName];

            for (const [topic, lastPublished] of Object.entries(
                node.publishers
            )) {
                if (topic in topics) {
                    if (topics[topic] < lastPublished) {
                        topics[topic] = lastPublished;
                    }
                } else {
                    topics[topic] = lastPublished;
                }
            }
        }

        return topics;
    }

    /**
     * Get a list of nodes which are subscribed to a specific topic.
     *
     * Note: This will not count nodes which have not been registered (such as
     * the nv cli)! If you want to include these subscribers, use
     * {@link getNumTopicSubscriptions} instead.
     *
     * @param {String} topic The topic to get subscribers for.
     *
     * @returns {Array} A list of nodes which are subscribed to the topic.
     */
    async getTopicSubscriptions(topic) {
        // First, get all registered nodes
        const nodes = await this.getNodes();

        // Then, filter out the nodes which are not subscribed to the topic
        const subscribers = Object.keys(nodes).filter((nodeName) => {
            const node = nodes[nodeName];

            return node.subscriptions.includes(topic);
        });

        return subscribers;
    }

    /**
     * Get the number of subscriptions to a specific topic,
     * including nodes which are not registered with the network.
     *
     * @param {String} topic The topic to get the number of subscribers for.
     *
     * @returns {Number} The number of subscribers to the topic.
     */
    async getNumTopicSubscriptions(topic) {
        const subs = await this._redis["pub"].pubsub("numsub", topic);

        return subs[1];
    }

    /**
     * Create a subscription.
     *
     * @param {String} channel The channel to subscribe to.
     * @param {Function} callback The callback to call when a message is
     * received.
     */
    createSubscription(channel, callback) {
        // Add the callback to the list of callbacks for the channel
        if (!this._subscriptions[channel]) {
            this._subscriptions[channel] = [];
        }

        this._subscriptions[channel].push(callback);

        // Subscribe to the channel
        this._redis["sub"].subscribe(channel);
    }

    /**
     * Remove a subscription.
     *
     * @param {String} channel The channel to unsubscribe from.
     * @param {Function} callback The callback to remove.
     */
    destroySubscription(channel, callback) {
        // Remove the callback from the list of callbacks for the channel
        if (this._subscriptions[channel]) {
            this._subscriptions[channel] = this._subscriptions[channel].filter(
                (cb) => cb !== callback
            );
        }

        // If there are no more callbacks for the channel, unsubscribe from it
        if (this._subscriptions[channel].length === 0) {
            this._redis["sub"].unsubscribe(channel);
            delete this._subscriptions[channel];
        }
    }

    /**
     * Publish a message to a channel.
     *
     * @param {String} channel The channel to publish to.
     * @param {Object} message The message to publish.
     */
    publish(channel, message) {
        // Update the publishers object
        this._publishers[channel] = Date.now() / 1000;

        // Encode the message
        message = this._encodePubSubMessage(message);

        // Publish the message
        this._redis["pub"].publish(channel, message);
    }

    /**
     * Get a parameter value from the parameter server.
     *
     * @param {String} name The name of the parameter to get.
     * @param {String} [nodeName] The name of the node to get the parameter from.
     *     If no node name is provided, the current node is used.
     *
     * @return {Promise} A promise which resolves to the parameter value.
     */
    async getParameter(name, { nodeName = null } = {}) {
        // If the node name is not provided, use the current node
        if (nodeName === null) {
            nodeName = this.name;
        }

        // Get the parameter from the parameter server
        const param = await this._redis["params"].get(`${nodeName}.${name}`);

        // If the parameter is not found, return null
        if (param === null) {
            return null;
        }

        // Extract the value from the parameter
        return JSON.parse(param)["value"];
    }

    /**
     * Get all parameters for a specific node, matching a pattern.
     *
     * @param {String} [nodeName] The name of the node to get parameters for.
     *     If no node name is provided, the current node is used.
     * @param {String} [match] The pattern to match parameters against.
     *     Defaults to "*", which matches all parameters.
     *
     * @return {Promise} A promise which resolves to a dictionary of
     * parameters.
     *
     * @example
     * // Get all parameters for the current node
     * const params = await nv.getParameters();
     *
     * // Get all parameters for the node 'node1'
     * const params = await nv.getParameters("node1");
     *
     * // Get all parameters for the node 'node1' matching 'foo*'
     * const params = await nv.getParameters("node1", "foo*");
     */
    async getParameters(
        { nodeName = null, match = "*" } = { nodeName: null, match: "*" }
    ) {
        // If the node name is not provided, use the current node
        if (nodeName === null) {
            nodeName = this.name;
        }

        const parameters = {};

        // Get all keys which start with the node name
        const keys = await this._redis["params"].keys(`${nodeName}.${match}`);

        // Loop over each key and extract the parameter name and value
        for (const key of keys) {
            const [, name] = key.split(".");

            parameters[name] = await this.getParameter(name, nodeName);
        }

        return parameters;
    }

    /**
     * Get a parameter description from the parameter server.
     *
     * @param {String} name The name of the parameter to get.
     * @param {String} [nodeName] The name of the node to get the parameter from.
     *     If no node name is provided, the current node is used.
     *
     * @return {Promise} A promise which resolves to the parameter description.
     */
    async getParameterDescription(name, { nodeName = null } = {}) {
        // If the node name is not provided, use the current node
        if (nodeName === null) {
            nodeName = this.name;
        }

        // Get the parameter from the parameter server
        const param = await this._redis["params"].get(`${nodeName}.${name}`);

        // If the parameter is not found, return null
        if (param === null) {
            return null;
        }

        // Extract the value from the parameter
        return JSON.parse(param)["description"];
    }

    /**
     * Set a parameter value on the parameter server.
     *
     * @param {String} name The name of the parameter to set.
     * @param value The value to set the parameter to.
     * @param {String} [nodeName] The name of the node to set the parameter on.
     *     If no node name is provided, the current node is used.
     * @param {String} [description] The description of the parameter.
     *
     * @example
     * // Set the parameter 'foo' to the value 'bar' on the current node
     * await nv.setParameter('foo', 'bar');
     *
     * // Set the parameter 'foo' to the value 'bar' on the node 'node1'
     * await nv.setParameter(
     *    'foo',
     *    'bar',
     *    { nodeName: 'node1' }
     * );
     */
    async setParameter(
        name,
        value,
        { nodeName = null, description = null } = {}
    ) {
        // If the node name is not provided, use the current node
        if (nodeName === null) {
            nodeName = this.name;
        }

        // Set the parameter on the parameter server
        return this._redis["params"].set(
            `${nodeName}.${name}`,
            JSON.stringify({
                value,
                description,
            })
        );
    }

    /**
     * Set multiple parameter values on the parameter server at once.
     *
     * @param {Object[]} parameters A list of parameter objects.
     * @param {String} parameters[].name The name of the parameter to set.
     * @param parameters[].value The value to set the parameter to.
     * @param {String} [parameters[].nodeName] The name of the node to set the parameter on.
     * If no node name is provided, the current node is used.
     * @param {String} [parameters[].description] The description of the parameter.
     *
     * @example
     * // Set the parameters 'foo' and 'bar' to the values 'bar' and 'baz'
     * // on the current node
     * await nv.setParameters([
     *     { name: 'foo', value: 'bar' },
     *     { name: 'bar', value: 'baz' }
     * ]);
     */
    async setParameters(parameters) {
        // Ensure all parameters have the required keys
        for (const parameter of parameters) {
            if (!parameter.nodeName) {
                parameter.nodeName = this.name;
            }

            if (!parameter.description) {
                parameter.description = null;
            }
        }

        // Create a pipe to send all updates at once
        const pipe = this._redis["params"].pipeline();

        // Loop over each parameter and set it on the parameter server
        for (const parameter of parameters) {
            pipe.set(
                `${parameter.nodeName}.${parameter.name}`,
                JSON.stringify({
                    value: parameter.value,
                    description: parameter.description,
                })
            );
        }

        // Execute the pipe
        return pipe.exec();
    }

    /**
     * Delete a parameter from the parameter server.
     *
     * @param {String} name The name of the parameter to delete.
     * @param {String} [nodeName] The name of the node to delete the parameter from.
     *    If no node name is provided, the current node is used.
     *
     * @example
     * // Delete the parameter 'foo' from the current node
     * nv.deleteParameter('foo');
     *
     * // Delete the parameter 'foo' from the node 'node1'
     * nv.deleteParameter('foo', { nodeName: 'node1' });
     */
    async deleteParameter(name, { nodeName = null } = {}) {
        // If the node name is not provided, use the current node
        if (nodeName === null) {
            nodeName = this.name;
        }

        // Delete the parameter from the parameter server
        return this._redis["params"].del(`${nodeName}.${name}`);
    }

    /**
     * Delete multiple parameter values on the parameter server at once.
     *
     * Supplying no arguments will delete all parameters on the current node.
     * Supplying only parameter names will use the current node.
     *
     * @param {Array} [names] An array of parameter names to delete. If not
     * specified, all parameters on the selected node will be deleted.
     * @param {String} [nodeName] The name of the node to delete parameters on. If not
     * specified, the current node will be used.
     *
     * @return {Promise} A promise which resolves when all the parameters have
     * been deleted.
     */
    async deleteParameters({ names = null, nodeName = null } = {}) {
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

    /**
     * Load a JSON file containing parameters, but don't set them on the
     * parameter server.
     *
     * To automatically load and set parameters on the parameter server, use
     * {@link setParametersFromFile}.
     *
     * Unlike the Python equivalent, this method has some limitations:
     * - The file must be a JSON file.
     * - No conditional statements are supported.
     *
     * @param {String} filePath The path to the file to load.
     *
     * @return {Promise} A promise which resolves to an object of parameters.
     *
     * @example
     * // Load the parameters from a file
     * const params = await nv.loadParametersFromFile('/path/to/parameters.json');
     */
    async loadParametersFromFile(filePath) {
        // Read the file
        const file = await fs.readFile(filePath, { encoding: "utf8" });

        // Parse the file
        return JSON.parse(file);
    }

    /**
     * Set multiple parameter values on the parameter server from a file.
     *
     * This method is similar to {@link loadParametersFromFile}, but it
     * automatically sets the parameters on the parameter server.
     *
     * Unlike the Python equivalent, this method has some limitations:
     * - The file must be a JSON file.
     * - No conditional statements are supported.
     *
     * @param {String} filePath The path to the file to load.
     *
     * @return {Promise} A promise which resolves when all the parameters have
     * been set.
     *
     * @example
     * // Load and set the parameters from a file
     * await nv.setParametersFromFile('/path/to/parameters.json');
     */
    async setParametersFromFile(filePath) {
        /**
         * Convert a parameter dictionary read from a file, to a list of
         * parameters suitable for sending to the parameter server.
         *
         * Supports subparameters, by recursively setting the parameter name as:
         *     `subparam.param = value1`
         *     `subparam1.subparam2.param = value2`
         *
         * @param {Object} parameterObject The parameter object to convert.
         * @param {String} _nodeName
         * @param {Array} _subparams
         */
        function convertToParameterList(
            parameterObject,
            { _nodeName = null, _subparams = [] } = {}
        ) {
            const parameterArray = [];

            // Loop over each parameter
            for (const [key, value] of Object.entries(parameterObject)) {
                // If this is the first level of the parameter, set the node name
                if (_nodeName === null) {
                    // Recurse all parameters
                    parameterArray.push(
                        ...convertToParameterList(value, {
                            _nodeName: key,
                        })
                    );
                } else if (typeof value === "object") {
                    // Recurse all parameters
                    parameterArray.push(
                        ...convertToParameterList(value, {
                            _nodeName: _nodeName,
                            _subparams: [..._subparams, key],
                        })
                    );
                } else {
                    // Set the parameter
                    parameterArray.push({
                        nodeName: _nodeName,
                        name: _subparams.concat(key).join("."),
                        value,
                    });
                }
            }

            return parameterArray;
        }

        this.log.info(`Setting parameters from file: ${filePath}`);

        // Load the parameters from the file
        const parameters = await this.loadParametersFromFile(filePath);

        const parametersList = convertToParameterList(parameters);

        return this.setParameters(parametersList);
    }
}
