/*
The `Node` class is the base class for all nodes in the network. It provides
methods for communicating between different nodes and the server, as well as
logging, parameter handling, and other things.

Callum Morrison, 2022
UNMND, Ltd.
<callum@unmnd.com>

All Rights Reserved
*/

const { promises: fs } = require("fs");

const winston = require("winston");
const Redis = require("ioredis");
const isValidUTF8 = require("utf-8-validate");

const utils = require("./utils.js");
const version = require("./version.js");
const { randomUUID } = require("crypto");

class Node {
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
        redisHost = null,
        redisPort = null,
    } = {}) {
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
        this._resolveNodeInitialisedPromise = null;
        this.nodeInitialised = new Promise((resolve) => {
            this._resolveNodeInitialisedPromise = resolve;
        });
        this.skipRegistration = skipRegistration;
        this.keepOldParameters = keepOldParameters;
        this.stopped = false;
        this._startTime = Date.now() / 1000;
        this.redisHost = redisHost;
        this.redisPort = redisPort;

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
        const redisHost = this.redisHost || process.env.NV_REDIS_HOST;
        const redisPort = this.redisPort || process.env.NV_REDIS_PORT || 6379;

        this._redis = {};

        // The topics database stores messages for communication between nodes.
        // The key is always the topic.
        this._redis["sub"] = await this._connectRedis(redisHost, {
            port: redisPort,
            db: 0,
        });

        // Handle received messages
        this._redis["sub"].on(
            "messageBuffer",
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

        // The service requests dict improves efficiency by allowing all service
        // requests to respond to the same topic (meaning only one subscription).
        // The queue keys are a unique request id, and the values contain a dict:
        // {
        //     "result": "success"/"error"
        //     "data": <response data>/<error message>,
        //     "event": Event()
        // }
        this._serviceRequests = {};

        // Generate a random ID for the service response channel for this node
        this._serviceResponseChannel = "srv://" + randomUUID();
        this.createSubscription(
            this._serviceResponseChannel,
            this._handleServiceCallback.bind(this)
        );

        // The nodeInitialised promise can be used to check if the node is
        // ready, useful when awaiting node.init() is not possible.
        this._resolveNodeInitialisedPromise();
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
        // Check the message is valid utf8
        if (isValidUTF8(message)) {
            return JSON.parse(message.toString());
        } else {
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
        // If the message is a buffer, don't encode it
        if (Buffer.isBuffer(message)) {
            return message;
        }

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
                callback(this._decodePubSubMessage(message));
            });
        }
    }

    /**
     * Handle responses from server requests. This works similarly to
     * `_handle_subscription_callback`, but is specific to messages received as
     * a response to a service request.
     *
     * Any response contains the following object:
     * ```
     * {
     *     result: "success"/"error",
     *     data: <response data>/<error message>,
     *     request_id: <request id>
     * }
     * ```
     *
     * @param {Object} message The message to handle
     */
    _handleServiceCallback(message) {
        // Save the result
        this._serviceRequests[message.request_id].result = message.result;

        // If the data is a string and starts with "NV_BYTES:" we need to fetch
        // the binary data directly from Redis.
        if (
            typeof message.data === "string" &&
            message.data.startsWith("NV_BYTES:")
        ) {
            this._serviceRequests[message.request_id].data = this._redis[
                "pub"
            ].get(message.data);
        } else {
            this._serviceRequests[message.request_id].data = message.data;
        }

        this._serviceRequests[message.request_id].timings = message.timings;

        // Resolve the promise to indicate the request has completed
        this._serviceRequests[message.request_id].resolvePromise();
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
        if (this.nodeRegistered) {
            this._deregisterNode();
        }

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
            const nodeInformation = await this.getNodeInformation({ nodeName });

            // Only update if node information is returned, this prevents the
            // error where a node is removed between the getNodesList call and here
            if (nodeInformation != null) {
                nodes[nodeName] = nodeInformation;
            }
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
                // Remove service topics
                if (topic.startsWith("srv://")) {
                    continue;
                }

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
     * Get all the services currently registered, and their topic ID used when
     * calling them.
     *
     * @returns {Object} A dictionary of services and their topic IDs.
     */
    async getServices() {
        // Get all nodes currently registered
        const nodes = await this.getNodes();

        // Loop over each node and add their services to the list
        const services = {};

        for (const nodeName in nodes) {
            const node = nodes[nodeName];

            for (const [topic, service] of Object.entries(node.services)) {
                services[topic] = service;
            }
        }

        return services;
    }

    /**
     * Wait for a service to be ready.
     *
     * This method is used to wait for a service to be ready before calling it.
     *  This is useful when a service is created in the same thread as the node,
     *  and the node needs to wait for the service to be ready before calling it.
     *
     * @param {String} service The service to wait for.
     * @param {Number} timeout The maximum amount of time to wait for the service
     * to be ready.
     *
     * @returns {Promise} A promise which resolves to true when the service is ready.
     *
     * @throws {Error} If the service does not exist after the timeout.
     */
    waitForServiceReady(serviceName, { timeout = 10000 } = {}) {
        return new Promise((resolve, reject) => {
            let timeoutFunc = null;

            const interval = setInterval(async () => {
                const services = await this.getServices();

                if (serviceName in services) {
                    clearInterval(interval);
                    clearTimeout(timeoutFunc);
                    resolve(true);
                }
            }, 100);

            timeoutFunc = setTimeout(() => {
                clearInterval(interval);
                throw new Error(
                    `Timeout waiting for service ${serviceName} to be ready`
                );
            }, timeout);
        });
    }

    /**
     * Create a service.
     *
     * A service is a function which can be called by other nodes. It can
     *  accept any number of args and kwargs, and can return most standard datatypes.
     *
     * @param {String} serviceName The name of the service.
     * @param {CallableFunction} callback The function to call when the service is
     * called.
     *
     * @example
     * // Create a service called "test"
     * node.createService("test", (a, b, c) => {
     *    return a + b + c;
     * });
     */
    createService(serviceName, callbackFunction) {
        /**
         * Used to handle requests to call a service, and respond by publishing
         * data back on the requested topic.
         *
         * @param {Object} message An object containing the request id, response
         * topic, and the args and kwargs to pass to the service.
         */
        const handleServiceCall = (message) => {
            let data;

            // Update timings
            message.timings.request_received = Date.now() / 1000;

            // Call the service
            try {
                data = callbackFunction(...message.args, message.kwargs);
                message.timings.request_completed = Date.now() / 1000;
            } catch (e) {
                this.log.error(
                    `Error handling service call: ${serviceName}\n${e}`
                );
                this.publish(message.response_topic, {
                    result: "error",
                    data: e.message,
                    request_id: message.request_id,
                    timings: message.timings,
                });
                return;
            }

            // If the data is bytes, we can't JSON serialise it. Instead, we
            // push it straight to Redis, and send the key in the service
            // response.
            if (Buffer.isBuffer(data)) {
                const key = "NV_BYTES:" + randomUUID();
                this._redis["pub"].set(key, data, "EX", 60);
                data = key;
            }

            // Publish the result on the response topic
            this.publish(message.response_topic, {
                result: "success",
                data: data,
                request_id: message.request_id,
                timings: message.timings,
            });
        };

        // Generate a unique id for the service
        const serviceId = "srv://" + randomUUID();

        // Register a message handler for the service
        this.createSubscription(serviceId, handleServiceCall);

        // Save the service name and ID
        this._services[serviceName] = serviceId;
    }

    /**
     * Call a service.
     *
     * @param {String} serviceName The name of the service to call.
     * @param {Array} args Positional args to pass to the service.
     * @param {Object} kwargs Keyword args to pass to the service.
     *
     * @returns {Promise} A promise which resolves to the result of the service.
     *
     * @throws {Error} If the service does not exist.
     *
     * @example
     * // Call the "test" service
     * const result = await node.callService("test", "Hello", "World");
     */
    async callService(serviceName, args = [], kwargs = {}) {
        // Throw an error if args or kwargs are not an array or object
        if (!(args instanceof Array)) {
            throw new Error(`args must be an array, got ${typeof args}`);
        } else if (!(kwargs instanceof Object)) {
            throw new Error(`kwargs must be an object, got ${typeof kwargs}`);
        }

        // Get all the services currently registered
        const services = await this.getServices();

        // Check the service exists
        if (!(serviceName in services)) {
            throw new Error(`Service ${serviceName} does not exist`);
        }

        // Get the service ID
        const serviceId = services[serviceName];

        // Generate a request ID
        const requestId = randomUUID();

        // Create the entry in the services requests object
        this._serviceRequests[requestId] = {
            resolvePromise: null,
        };

        // This allows the promise to be resolved from the message callback
        this._serviceRequests[requestId].event = new Promise(
            (resolve, reject) => {
                this._serviceRequests[requestId].resolvePromise = resolve;
            }
        );

        // Create a message to send to the service
        const message = {
            timings: {
                start: Date.now() / 1000,
            },
            response_topic: this._serviceResponseChannel,
            request_id: requestId,
            args: args,
            kwargs: kwargs,
        };

        // Call the service
        this.publish(serviceId, message);

        // Wait for the response
        await this._serviceRequests[requestId].event;

        // Check for errors
        if (this._serviceRequests[requestId].result === "error") {
            throw new Error(this._serviceRequests[requestId].data);
        }

        // Extract the data
        const data = this._serviceRequests[requestId].data;
        const timings = this._serviceRequests[requestId].timings;

        // Complete timings
        timings.end = Date.now() / 1000;

        // Format timings as durations for print
        const durations = Object.entries(timings).map(
            ([key, value], i) =>
                `${Math.round((value - timings.start) * 1000)}ms (${key})`
        );

        // Print and format the cumulative timings
        this.log.debug(
            `Service ${serviceName} timings: ${durations.join(" -> ")}`
        );

        // Delete the request
        delete this._serviceRequests[requestId];

        return data;
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

exports.Node = Node;
