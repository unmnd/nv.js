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

        // Setup node name
        if (nodeName === "") {
            nodeName = utils.generateName();
        } else {
            nodeName = nodeName;
        }

        // // Check if the node should be started by calling this.nodeCondition()
        // while (!this.nodeCondition()) {
        //     this.log.info("Node condition not met, waiting...");
        // }

        this.log.debug(
            `Initialising ${nodeName} using framework.js version nv ${version.__version__}`
        );

        // Initialise parameters
        this.name = nodeName;
        this.nodeRegistered = false;
        this.skipRegistration = skipRegistration;
        this.stopped = false;
        this._start_time = Date.now();

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

        // Connect redis clients
        // The topics database stores messages for communication between nodes.
        // The key is always the topic.
        const redisHost = process.env.NV_REDIS_HOST;
        const redisPort = process.env.NV_REDIS_PORT || 6379;

        this._redis_topics = this._connectRedis({
            host: redisHost,
            port: redisPort,
            db: 0,
        });
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
}
