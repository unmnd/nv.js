import { randomUUID, type UUID } from "crypto";
import { readFile } from "fs/promises";
import Redis, { type RedisOptions } from "ioredis";
import os from "os";
import winston from "winston";

import type {
    JsonFile,
    MessageServiceRequest,
    MessageServiceResponse,
    MessageTerminateNode,
    NodeInformation,
    NodeOptions,
    NodePS,
    Parameter,
    ParameterName,
    PublishableData,
    ServiceCallback,
    ServiceHandler,
    ServiceID,
    ServiceName,
    SubscriptionCallback,
    TopicName,
} from "./interface.js";
import * as utils from "./utils.js";
import { __version__ } from "./version.js";

const PLATFORM = os.type() + " " + os.release() + " " + os.arch();

export abstract class Node {
    // Node properties
    private readonly _name: string;
    private readonly _startTime: number = Math.round(Date.now() / 1000);
    private _stopped: boolean = false;
    private _nodeRegistered: boolean = false;
    private _processUsage: {
        cpu: NodeJS.CpuUsage;
        time: number;
    } = {
        cpu: process.cpuUsage(),
        time: Date.now(),
    };

    /** Track which topics the node is subscribed tp */
    private readonly _subscriptions: {
        [key: TopicName]: SubscriptionCallback[];
    } = {};

    /** Track the last time a topic was published to */
    private readonly _publishers: {
        [key: TopicName]: number;
    } = {};

    /** A map of service names to their unique redis topic */
    private readonly _services: {
        [key: TopicName]: ServiceID;
    } = {};

    /**
     * The service requests dict improves efficiency by allowing all service
     * requests to respond to the same topic (meaning only one subscription).
     */
    private readonly _serviceRequests: {
        [key: UUID]: ServiceHandler;
    } = {};

    /** The random channel used for service responses to this node */
    private readonly _serviceResponseChannel: ServiceID = `srv://${randomUUID()}`;

    /** Redis client instances */
    private _redis!: {
        /**
         * The subscriptions database stores messages for communication between
         * nodes. The key is always the topic.
         */
        sub: Redis;

        /**
         * The publishers database is a mirror of the subscriptions database, as
         * ioredis does not allow subscriptions on the same client as publishing.
         */
        pub: Redis;

        /**
         * The parameters database stores key-value parameters to be used for each
         * node. The key is the node_name.parameter_name.
         */
        params: Redis;

        /**
         * The transforms database stores transformations between frames. The key
         * is in the form <source_frame>:<target_frame>.
         */
        transforms: Redis;

        /**
         * The nodes database stores up-to-date information about which nodes are
         * active on the network. Each node is responsible for storing and keeping
         * it's own information active.
         */
        nodes: Redis;
    };

    // Initialisation promises
    private _resolveNodeInitialisedPromise: (
        value?: void | PromiseLike<void>,
    ) => void = () => {};
    /* eslint-disable  @typescript-eslint/no-explicit-any */
    private _rejectNodeInitialisedPromise: (reason?: any) => void = () => {};
    private readonly _nodeInitialised: Promise<void> = new Promise(
        (resolve, reject) => {
            this._resolveNodeInitialisedPromise = resolve;
            this._rejectNodeInitialisedPromise = reject;
        },
    );

    // Initialisation parameters
    private readonly skipRegistration: boolean;
    private readonly keepOldParameters: boolean;
    private readonly redisHost?: string;
    private readonly redisPort?: number;

    // Inheritable properties
    protected readonly log: winston.Logger;
    protected readonly workspace?: string;
    protected readonly timeouts: {
        [key: string]: ReturnType<typeof setTimeout>;
    } = {};

    get name(): string {
        return this._name;
    }

    get stopped(): boolean {
        return this._stopped;
    }

    get startTime(): number {
        return this._startTime;
    }

    get nodeRegistered(): boolean {
        return this._nodeRegistered;
    }

    get nodeInitialised(): Promise<void> {
        return this._nodeInitialised;
    }

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
     * @param nodeName The name of the node. If not provided, a random name will
     *    be generated.
     * @param skipRegistration Whether to skip the registration of the node with
     *   the server. This should not be used for normal nodes, but is useful for
     *  commandline access.
     * @param logLevel The log level to use.
     * @param keepOldParameters Whether to keep old parameters from previous
     * instances of this node.
     * @param workspace An optional workspace to use for topics.
     * @param redisHost Force the Redis host to use.
     * @param redisPort Force the Redis port to use.
     */
    constructor({
        nodeName,
        skipRegistration = false,
        logLevel,
        logModule,
        logger,
        keepOldParameters = false,
        workspace,
        redisHost,
        redisPort,
    }: NodeOptions = {}) {
        // Bind callbacks to gracefully exit the node on signal
        process.on("SIGINT", this._sigtermHandler.bind(this));
        process.on("SIGTERM", this._sigtermHandler.bind(this));

        // Generate a random node name if none is provided
        this._name = nodeName ?? utils.generateName();

        // Initialise logger
        this.log =
            logger ??
            utils.createLogger({
                level: logLevel,
                module: logModule,
            });

        // Initialise parameters
        this.skipRegistration = skipRegistration;
        this.keepOldParameters = keepOldParameters;
        this.redisHost = redisHost;
        this.redisPort = redisPort;

        // Workspace used for topic names
        this.workspace = workspace || process.env.NV_WORKSPACE;

        this.log.info(
            workspace
                ? `Using workspace ${workspace}`
                : "No workspace specified",
        );
    }

    /**
     * Initialise the node. This should be called immediately after
     * inheriting the Node class.
     */
    async init() {
        try {
            // Wait for the node condition to be met
            try {
                await this.nodeCondition();
            } catch (e) {
                this.log.error("Node condition failed, exiting");
                throw e;
            }

            this.log.debug(
                `Initialising ${this._name} using framework.js version nv ${__version__}`,
            );

            // Connect redis clients
            const redisHost = this.redisHost || process.env.NV_REDIS_HOST;
            const redisPort =
                this.redisPort ?? process.env.NV_REDIS_PORT
                    ? Number(process.env.NV_REDIS_PORT)
                    : undefined;

            const redisConnectionOptions = this._connectRedis({
                ...(redisHost && { host: redisHost }),
                ...(redisPort && { port: redisPort }),
            });

            this._redis = {
                sub: new Redis({
                    ...redisConnectionOptions,
                    db: 0, // pub/sub database
                }),

                pub: new Redis({
                    ...redisConnectionOptions,
                    db: 0, // pub/sub database
                }),

                params: new Redis({
                    ...redisConnectionOptions,
                    db: 1, // parameters database
                }),

                transforms: new Redis({
                    ...redisConnectionOptions,
                    db: 2, // transforms database
                }),

                nodes: new Redis({
                    ...redisConnectionOptions,
                    db: 3, // nodes database
                }),
            };

            this._redis.sub.on(
                "messageBuffer",
                this._handleSubscriptionCallback.bind(this),
            );

            if (this.skipRegistration) {
                this.log.warn("Skipping node registration...");
            } else {
                // Check if the node exists
                if (await this._redis.nodes.exists(this._name)) {
                    this.log.info(
                        `Node ${this._name} already exists, waiting to see if it disappears...`,
                    );

                    // Wait up to 10 seconds for the node to disappear
                    let nodeExists = 1;
                    for (let i = 0; i < 10; i++) {
                        nodeExists = await this._redis.nodes.exists(this._name);
                        if (nodeExists === 0) {
                            break;
                        }
                        await utils.sleep(1000);
                    }

                    if (nodeExists) {
                        throw new Error(`Node ${this._name} still exists`);
                    }
                }

                // Register the node
                this.log.info(`Registering node ${this._name}`);

                await this._registerNode();

                // Remove residual parameters if required
                if (!this.keepOldParameters) {
                    await this.deleteAllParameters();
                }
            }

            // Generate a random ID for the service response channel for this node
            this.createSubscription(
                this._serviceResponseChannel,
                this._handleServiceCallback.bind(
                    this,
                ) as unknown as SubscriptionCallback,
            );

            // Used to terminate the node remotely
            this.createSubscription(
                "nv_terminate",
                this._handleTerminateCallback.bind(
                    this,
                ) as unknown as SubscriptionCallback,
            );

            this.log.info(`Node ${this._name} initialised`);

            // The nodeInitialised promise can be used to check if the node is
            // ready, useful when awaiting node.init() is not possible.
            this._resolveNodeInitialisedPromise();
        } catch (e) {
            this._rejectNodeInitialisedPromise(e);
            throw e;
        }
    }

    /**
     * Register the node with the network.
     */
    private async _registerNode() {
        this.timeouts["renew_node_information"] = setInterval(
            this._renewNodeInformation.bind(this),
            5000,
        );
        this._renewNodeInformation();

        this._nodeRegistered = true;
        this.log.info(`Node ${this._name} registered`);
    }

    private async _renewNodeInformation() {
        if (!this._nodeRegistered || this._stopped) {
            return;
        }

        this._redis.nodes.set(
            this._name,
            JSON.stringify(await this.getNodeInformation()),
            "EX",
            10,
        );
    }

    /**
     * Deregister the node from the network.
     */
    private _deregisterNode() {
        this._nodeRegistered = false;
        this._redis.nodes.del(this._name);

        this.log.info(`Node ${this._name} deregistered`);
    }

    /**
     * Attempt to find a Redis instance automatically, or connect to a specific
     * host if provided.
     *
     * @param options The options to pass to the Redis client.
     * @returns The confirmed working options.
     */
    private async _connectRedis(options: RedisOptions): Promise<RedisOptions> {
        const optionsToTry = [
            options,
            {
                host: "localhost",
                port: 6379,
                ...options,
            },
            {
                host: "redis",
                port: 6379,
                ...options,
            },
        ];

        for (const opts of optionsToTry) {
            try {
                await new Redis({ ...opts, lazyConnect: true }).connect();
                return opts;
            } catch (e) {
                this.log.warn(
                    `Could not connect to Redis at ${opts.host}:${opts.port}`,
                );
            }
        }

        throw new Error(
            `Could not connect to Redis at any of the provided hosts`,
        );
    }

    /**
     * Decode a message from the network.
     *
     * @param message The message to decode.
     *
     * @returns The decoded message.
     */
    private _decodePubSubMessage(message: string | Buffer): PublishableData {
        try {
            return JSON.parse(message.toString());
        } catch (e) {
            return message;
        }
    }

    /**
     * Encode a message to be sent to the network.
     *
     * @param message The message to encode.
     *
     * @returns The encoded message.
     */
    private _encodePubSubMessage(message: PublishableData): string | Buffer {
        // If the message is a buffer, don't encode it
        if (Buffer.isBuffer(message)) {
            return message;
        }

        return JSON.stringify(message);
    }

    /**
     * Handle a message received from the network.
     *
     * @param topic The channel the message was received on.
     * @param message The message received.
     */
    private _handleSubscriptionCallback(
        topic: TopicName,
        message: string | Buffer,
    ) {
        const callbacks = this._subscriptions[topic];

        if (callbacks) {
            callbacks.forEach((callback) => {
                callback(this._decodePubSubMessage(message));
            });
        }
    }

    /**
     * Handle responses from server requests. This works similarly to
     * {@link _handleSubscriptionCallback}, but is specific to messages received as
     * a response to a service request.
     *
     * @param message The message received.
     */
    private async _handleServiceCallback(message: MessageServiceResponse) {
        // Save the result
        this._serviceRequests[message.request_id].result = message.result;

        // If the data is a string and starts with "NV_BYTES:" we need to fetch
        // the binary data directly from Redis.
        if (
            typeof message.data === "string" &&
            message.data.startsWith("NV_BYTES:")
        ) {
            this._serviceRequests[message.request_id].data = await this._redis[
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
     * Handle node termination requests.
     *
     * @param message The termination message.
     */
    private _handleTerminateCallback(message: MessageTerminateNode) {
        if (message.node === this._name) {
            this.log.info(
                `Node terminated remotely with reason: ${message.reason}`,
            );
            this.destroyNode();
        }
    }

    /**
     * Handle termination signals to gracefully stop the node.
     */
    private _sigtermHandler() {
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
     * @returns A promise which resolves when the node condition is met.
     */
    protected async nodeCondition(): Promise<void> {
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
     * @returns The name of this node.
     */
    getName() {
        return this._name;
    }

    /**
     * Destroy the node.
     *
     * This will remove the node from the network and stop the node.
     */
    destroyNode() {
        if (this._stopped) {
            this.log.warn("Node already stopped");
            return;
        }

        this.log.info(`Destroying node ${this._name}`);

        // Remove the node from the list of nodes
        if (this._nodeRegistered) {
            this._deregisterNode();
        }

        // Stop any timers or services running
        this._stopped = true;
        for (const [key, t] of Object.entries(this.timeouts)) {
            this.log.debug(`Cancelling timeout: ${key}`);
            clearTimeout(t);
        }

        this._redis.sub.quit();
        this._redis.pub.quit();
        this._redis.params.quit();
        this._redis.transforms.quit();
        this._redis.nodes.quit();
    }

    /**
     * Get process information about the node.
     *
     * @returns The process information.
     */
    getNodePS(): NodePS {
        // Get the cpu usage by calculating how many active miliseconds have
        // occured since the last check.
        const usage = process.cpuUsage(this._processUsage.cpu);
        const result =
            (100 * (usage.user + usage.system)) /
            ((Date.now() - this._processUsage.time) * 1000);

        // Save the current usage for the next check
        this._processUsage.cpu = process.cpuUsage();
        this._processUsage.time = Date.now();

        return {
            pid: process.pid,
            cpu: Math.round(result * 100) / 100,
            memory: process.memoryUsage().rss,
            platform: PLATFORM,
            lang: "Node.js " + process.version,
        };
    }

    /**
     * Return the node information dictionary.
     *
     * If a node name is provided, the information for that node is returned. If
     * no node name is provided, the information for the current node is
     * returned.
     *
     * @param nodeName The name of the node to get
     * information for (defaults to the current node)
     *
     * @return The node information dictionary.
     */
    async getNodeInformation(
        nodeName: string = this._name,
    ): Promise<NodeInformation> {
        if (nodeName === this._name) {
            return {
                time_registered: this._startTime,
                time_modified: Math.round(Date.now() / 1000),
                version: __version__ + "-js",
                subscriptions: Object.keys(this._subscriptions),
                publishers: this._publishers,
                services: this._services,
                ps: this.getNodePS(),
            };
        } else {
            const nodeInfo = await this._redis.nodes.get(nodeName);

            if (nodeInfo === null) {
                throw new Error(`Node ${nodeName} does not exist`);
            }

            return JSON.parse(nodeInfo);
        }
    }

    /**
     * Get all nodes present in the network.
     *
     * @returns A dictionary of node information.
     */
    async getNodes(): Promise<{
        [key: string]: NodeInformation;
    }> {
        const nodeNames = await this.getNodesList();

        const nodes: {
            [key: string]: NodeInformation;
        } = {};

        for (const nodeName of nodeNames) {
            try {
                nodes[nodeName] = await this.getNodeInformation(nodeName);
            } catch (e) {
                this.log.warn(`Error getting node information: ${e}`);
            }
        }

        return nodes;
    }

    /**
     * Get a list of all nodes present in the network.
     *
     * @returns A list of node names.
     */
    async getNodesList() {
        return await this._redis.nodes.keys("*");
    }

    /**
     * Check if a node with the given name exists.
     *
     * @param  nodeName The name of the node to check.
     *
     * @return True if the node exists, false otherwise.
     */
    async checkNodeExists(nodeName: string) {
        return this._redis.nodes.exists(nodeName);
    }

    /**
     * Get all topics present in the network.
     *
     * @returns A dictionary containing all topics on the network, and
     * the time of their most recent message.
     */
    async getTopics() {
        const topics: {
            [key: TopicName]: number;
        } = {};

        const nodes = await this.getNodes();

        // Loop over each node and add their publishers to the list. If the topic
        // already exists, the most recent publish time is used.
        for (const nodeName in nodes) {
            const node = nodes[nodeName];

            for (const [topic, lastPublished] of Object.entries(
                node.publishers,
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
     * @param topic The topic to get subscribers for.
     *
     * @returns A list of nodes which are subscribed to the topic.
     */
    async getTopicSubscriptions(topic: TopicName): Promise<string[]> {
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
     * @param topic The topic to get the number of subscribers for.
     *
     * @returns The number of subscribers to the topic.
     */
    async getNumTopicSubscriptions(topic: TopicName): Promise<number> {
        const subs = await this._redis.pub.pubsub("NUMSUB", topic);

        return subs[1] as number;
    }

    /**
     * Create a subscription.
     *
     * @param topic The topic to subscribe to.
     * @param callback The callback to call when a message is received.
     */
    createSubscription(topic: TopicName, callback: SubscriptionCallback) {
        // Add the callback to the list of callbacks for the channel
        if (!this._subscriptions[topic]) {
            this._subscriptions[topic] = [];
        }

        this._subscriptions[topic].push(callback);

        // Subscribe to the channel
        this._redis.sub.subscribe(topic);

        // Update node information
        this._renewNodeInformation();
    }

    /**
     * Remove a subscription.
     *
     * @param topic The channel to unsubscribe from.
     * @param callback The callback to remove.
     */
    destroySubscription(topic: TopicName, callback: SubscriptionCallback) {
        // Remove the callback from the list of callbacks for the channel
        if (this._subscriptions[topic]) {
            this._subscriptions[topic] = this._subscriptions[topic].filter(
                (cb) => cb !== callback,
            );
        }

        // If there are no more callbacks for the channel, unsubscribe from it
        if (this._subscriptions[topic].length === 0) {
            this._redis.sub.unsubscribe(topic);
            delete this._subscriptions[topic];
        }

        // Update node information
        this._renewNodeInformation();
    }

    /**
     * Convert a topic name to an absolute topic name.
     *
     * nv topics default to the global workspace, but this can be overridden by
     *  proceeding the topic with a ".", which will automatically add the node
     *   name.
     *
     *       A custom workspace can be added in the node setup or using an
     *      environment variable.
     *
     * @param topic The topic to convert.
     *
     * @returns The absolute topic name.
     */
    getAbsoluteTopic(topic: TopicName): TopicName {
        if (topic.startsWith(".")) {
            topic = this._name + topic;
        }

        if (this.workspace && !topic.startsWith(this.workspace)) {
            topic = `${this.workspace}.${topic}`;
        }

        return topic;
    }

    /**
     * Publish a message to a topic.
     *
     * @param topic The topic to publish to.
     * @param message The message to publish.
     */
    publish(topic: TopicName, message: PublishableData) {
        // Conver the topic name to an absolute topic name
        topic = this.getAbsoluteTopic(topic);

        // Update the publishers object
        this._publishers[topic] = Date.now() / 1000;

        // Encode the message
        message = this._encodePubSubMessage(message);

        // Publish the message
        this._redis.pub.publish(topic, message);
    }

    /**
     * Get all the services currently registered, and their topic ID used when
     * calling them.
     *
     * @returns A dictionary of services and their topic IDs.
     */
    async getServices(): Promise<{
        [key: ServiceName]: ServiceID;
    }> {
        // Get all nodes currently registered
        const nodes = await this.getNodes();

        return Object.entries(nodes).reduce((services, [_nodeName, node]) => {
            return {
                ...services,
                ...node.services,
            };
        }, {});
    }

    /**
     * Wait for a service to be ready.
     *
     * This method is used to wait for a service to be ready before calling it.
     *  This is useful when a service is created in the same thread as the node,
     *  and the node needs to wait for the service to be ready before calling it.
     *
     * @param serviceName The service to wait for.
     * @param timeout The maximum amount of time to wait for the service
     * to be ready.
     *
     * @returns A promise which resolves when the service is ready.
     * @throws If the service does not exist after the timeout.
     */
    async waitForServiceReady(
        serviceName: ServiceName,
        timeout: number = 10000,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            this.log.debug(`Waiting for service ${serviceName} to be ready...`);

            const interval = setInterval(async () => {
                const services = await this.getServices();

                if (serviceName in services) {
                    clearInterval(interval);
                    clearTimeout(timeoutFunc);

                    this.log.debug(
                        `Service ${serviceName} is ready after ${Date.now() - startTime}ms`,
                    );

                    resolve();
                }
            }, 100);

            const timeoutFunc = setTimeout(() => {
                clearInterval(interval);
                reject();
                throw new Error(
                    `Timeout waiting for service ${serviceName} to be ready`,
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
     * @remark For large data (several bytes), it's highly recommended to send
     * as Buffers, which uses a different transmission method which is *way*
     * faster for large data.
     *
     * @param serviceName The name of the service.
     * @param callback The function to call when the service is
     * called.
     *
     * @example Create a service called "test"
     * node.createService("test", (a, b, c) => {
     *    return a + b + c;
     * });
     */
    createService(serviceName: ServiceName, callback: ServiceCallback) {
        /**
         * Used to handle requests to call a service, and respond by publishing
         * data back on the requested topic.
         *
         * @param message An object containing the request id, response
         * topic, and the args and kwargs to pass to the service.
         */
        const handleServiceCall = async (message: MessageServiceRequest) => {
            // Update timings
            message.timings.push(["request_received", Date.now() / 1000]);

            // Call the service
            let data: PublishableData;
            try {
                data = await callback(message.args, message.kwargs);
                message.timings.push(["request_completed", Date.now() / 1000]);
            } catch (e) {
                this.log.error(`Error handling service call: ${serviceName}`);
                this.log.error(e);
                this.publish(message.response_topic, {
                    result: "error",
                    data: (e as Error).message,
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
                this._redis.pub.set(key, data, "EX", 60);
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
        const serviceID: ServiceID = `srv://${randomUUID()}`;

        // Register a message handler for the service
        this.createSubscription(
            serviceID,
            handleServiceCall as unknown as SubscriptionCallback,
        );

        // Save the service name and ID
        this._services[serviceName] = serviceID;

        // Update node information
        this._renewNodeInformation();
    }

    /**
     * Call a service.
     *
     * @param serviceName The name of the service to call.
     * @param args Positional args to pass to the service.
     * @param kwargs Keyword args to pass to the service.
     *
     * @returns A promise which resolves to the result of the service.
     * @throws If the service does not exist.
     *
     * @example
     * // Call the "test" service
     * const result = await node.callService("test", ["Hello", "World"]);
     */
    async callService(
        serviceName: ServiceName,
        {
            args = [],
            kwargs = {},
        }: {
            args?: PublishableData[];
            kwargs?: { [key: string]: PublishableData };
        } = {},
    ): Promise<PublishableData> {
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
        const serviceID = services[serviceName];

        // Generate a request ID
        const requestID = randomUUID();

        // This allows the promise to be resolved from the message callback
        let resolvePromise: () => void = () => {};
        this._serviceRequests[requestID] = {
            event: new Promise((resolve, _reject) => {
                resolvePromise = resolve;
            }),
            resolvePromise,
        };

        // Create a message to send to the service
        const message: MessageServiceRequest = {
            timings: [["start", Date.now() / 1000]],
            response_topic: this._serviceResponseChannel,
            request_id: requestID,
            args: args,
            kwargs: kwargs,
        };

        // Call the service
        this.publish(serviceID, message);

        // Wait for the response
        await this._serviceRequests[requestID].event;

        const { data, timings, result } = this._serviceRequests[
            requestID
        ] as Required<ServiceHandler>; // All properties should be set after resolving

        // Check for errors
        if (result === "error") {
            throw new Error(data);
        }

        // Complete timings
        timings.push(["end", Date.now() / 1000]);

        // Format timings as durations for print
        const durations = timings.map(
            ([key, value]) =>
                `${Math.round((value - timings[0][1]) * 1000)}ms (${key})`,
        );

        // Print and format the cumulative timings
        this.log.debug(
            `Service ${serviceName} timings: ${durations.join(" -> ")}`,
        );

        // Delete the request
        delete this._serviceRequests[requestID];

        return data;
    }

    /**
     * Get a parameter value from the parameter server.
     *
     * @param name The name of the parameter to get.
     * @param nodeName The name of the node to get the parameter from.
     *     If no node name is provided, the current node is used.
     *
     * @return The parameter value.
     * @throws If the parameter does not exist.
     */
    async getParameter(
        name: ParameterName,
        { nodeName = this._name }: { nodeName?: string } = {},
    ): Promise<PublishableData> {
        // Get the parameter from the parameter server
        const param = await this._redis.params.get(`${nodeName}.${name}`);

        // If the parameter is not found, raise an error
        if (param === null) {
            throw new Error(`Parameter ${name} does not exist`);
        }

        // Extract the value from the parameter
        return JSON.parse(param)["value"];
    }

    /**
     * Get all parameters for a specific node, matching a pattern.
     *
     * @param nodeName The name of the node to get parameters for.
     *     If no node name is provided, the current node is used.
     * @param match The pattern to match parameters against.
     *     Defaults to "*", which matches all parameters.
     *
     * @return An object containing all parameters for the node.
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
    async getParameters({
        nodeName = this._name,
        match = "*",
    }: {
        nodeName?: string;
        match?: string;
    } = {}): Promise<{ [key: ParameterName]: PublishableData }> {
        const parameters: { [key: ParameterName]: PublishableData } = {};

        // Get all keys which start with the node name
        const keys = await this._redis.params.keys(`${nodeName}.${match}`);

        // Loop over each key and extract the parameter name and value
        for (const key of keys) {
            const [, name] = key.split(".");

            parameters[name] = await this.getParameter(name, { nodeName });
        }

        return parameters;
    }

    /**
     * Get a parameter description from the parameter server.
     *
     * @param name The name of the parameter to get.
     * @param nodeName The name of the node to get the parameter from.
     *     If no node name is provided, the current node is used.
     *
     * @return The parameter description.
     * @throws If the parameter does not exist.
     */
    async getParameterDescription(
        name: ParameterName,
        { nodeName = this._name }: { nodeName?: string } = {},
    ): Promise<string> {
        // Get the parameter from the parameter server
        const param = await this._redis.params.get(`${nodeName}.${name}`);

        // If the parameter is not found, raise an error
        if (param === null) {
            throw new Error(`Parameter ${name} does not exist`);
        }

        // Extract the value from the parameter
        return (JSON.parse(param) as Parameter)["description"];
    }

    /**
     * Set a parameter value on the parameter server.
     *
     * @param name The name of the parameter to set.
     * @param value The value to set the parameter to.
     * @param description The description of the parameter.
     * @param nodeName The name of the node to set the parameter on.
     *     If no node name is provided, the current node is used.
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
        name: ParameterName,
        value: PublishableData,
        {
            nodeName = this._name,
            description = "",
        }: {
            nodeName?: string;
            description?: string;
        } = {},
    ) {
        this._redis.params.set(
            `${nodeName}.${name}`,
            JSON.stringify({
                value,
                description,
            }),
        );
    }

    /**
     * Set multiple parameter values on the parameter server at once.
     *
     * @param parameters A list of parameter objects.
     *
     * @example
     * // Set the parameters 'foo' and 'bar' to the values 'bar' and 'baz'
     * // on the current node
     * await nv.setParameters([
     *     { name: 'foo', value: 'bar' },
     *     { name: 'bar', value: 'baz' }
     * ]);
     */
    async setParameters(
        parameters: {
            name: ParameterName;
            value: PublishableData;
            nodeName?: string;
            description?: string;
        }[],
    ) {
        // Ensure all parameters have the required keys
        for (const parameter of parameters) {
            if (!parameter.nodeName) {
                parameter.nodeName = this._name;
            }

            if (!parameter.description) {
                parameter.description = "";
            }
        }

        // Create a pipe to send all updates at once
        const pipe = this._redis.params.pipeline();

        // Loop over each parameter and set it on the parameter server
        for (const parameter of parameters) {
            pipe.set(
                `${parameter.nodeName}.${parameter.name}`,
                JSON.stringify({
                    value: parameter.value,
                    description: parameter.description,
                } as Parameter),
            );
        }

        // Execute the pipe
        pipe.exec();
    }

    /**
     * Delete a parameter from the parameter server.
     *
     * @param name The name of the parameter to delete.
     * @param nodeName The name of the node to delete the parameter from.
     *    If no node name is provided, the current node is used.
     *
     * @example
     * // Delete the parameter 'foo' from the current node
     * nv.deleteParameter('foo');
     *
     * // Delete the parameter 'foo' from the node 'node1'
     * nv.deleteParameter('foo', 'node1' );
     */
    async deleteParameter(
        name: ParameterName,
        { nodeName = this._name }: { nodeName?: string } = {},
    ) {
        this._redis.params.del(`${nodeName}.${name}`);
    }

    /**
     * Delete multiple parameter values on the parameter server at once.
     *
     * @param parameters A list of parameter objects.
     */
    async deleteParameters(
        parameters: {
            name: ParameterName;
            nodeName?: string;
        }[],
    ) {
        // Create a pipe to send all updates at once
        const pipe = this._redis.params.pipeline();

        // Loop over each parameter and set it for deletion
        for (const parameter of parameters) {
            if (!parameter.nodeName) {
                parameter.nodeName = this._name;
            }

            pipe.del(`${parameter.nodeName}.${parameter.name}`);
        }

        // Execute the pipe
        pipe.exec();
    }

    /**
     * Delete all parameters for a specific node.
     *
     * @param nodeName The name of the node to delete parameters for.
     */
    async deleteAllParameters(nodeName: string = this._name) {
        // Get all keys which start with the node name
        const keys = await this._redis.params.keys(`${nodeName}.*`);

        // Create a pipe to delete all keys at once
        const pipe = this._redis.params.pipeline();

        // Loop over each key and delete the parameter
        for (const key of keys) {
            pipe.del(key);
        }

        // Execute the pipe
        pipe.exec();
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
     * @param filePath The path to the file to load.
     *
     * @return The parameters loaded from the file.
     *
     * @example
     * // Load the parameters from a file
     * const params = await nv.loadParametersFromFile('/path/to/parameters.json');
     */
    async loadParametersFromFile(filePath: JsonFile) {
        // Read the file
        const file = await readFile(filePath, { encoding: "utf8" });

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
     * @param filePath The path to the file to load.
     *
     * @example
     * // Load and set the parameters from a file
     * await nv.setParametersFromFile('/path/to/parameters.json');
     */
    async setParametersFromFile(filePath: JsonFile) {
        function isObject(obj: unknown): obj is { [key: string]: unknown } {
            return (
                obj !== null && typeof obj === "object" && !Array.isArray(obj)
            );
        }

        /**
         * Convert a parameter dictionary read from a file, to a list of
         * parameters suitable for sending to the parameter server.
         *
         * Supports subparameters, by recursively setting the parameter name as:
         *     `subparam.param = value1`
         *     `subparam1.subparam2.param = value2`
         *
         * @param parameterObject The parameter object to convert.
         * @param _nodeName Used internally to track the current node name.
         * @param _subparams Used internally to track the current subparameters.
         */
        function convertToParameterList(
            parameterObject: { [key: string]: PublishableData },
            _nodeName?: string,
            _subparams: string[] = [],
        ): { nodeName: string; name: string; value: PublishableData }[] {
            const parameterArray = [];

            // Loop over each parameter
            for (const [key, value] of Object.entries(parameterObject)) {
                // If this is the first level of the parameter, set the node name
                if (_nodeName === undefined) {
                    // Recurse all parameters
                    parameterArray.push(
                        ...convertToParameterList(
                            value as { [key: string]: PublishableData },
                            key,
                        ),
                    );
                } else if (isObject(value)) {
                    // Recurse all parameters
                    parameterArray.push(
                        ...convertToParameterList(value, _nodeName, [
                            ..._subparams,
                            key,
                        ]),
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
