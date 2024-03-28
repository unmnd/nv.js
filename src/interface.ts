import type { UUID } from "crypto";

export interface NodeOptions {
    nodeName?: string;
    skipRegistration?: boolean;
    logLevel?: string;
    keepOldParameters?: boolean;
    workspace?: string;
    redisHost?: string;
    redisPort?: number;
}

type Primative = string | number | boolean | null;
export type PublishableData =
    | Buffer
    | Primative
    | PublishableData[]
    | { [key: string]: PublishableData };

export type TopicName = string;
export type ServiceID = `srv://${UUID}`;
export type SubscriptionCallback = (data: PublishableData) => void;
export type ServiceCallback = (
    ...args: [...PublishableData[], kwargs: { [key: string]: PublishableData }]
) => PublishableData | Promise<PublishableData>;

export type NodePS = {
    pid: number;
    cpu: number;
    memory: number;
    platform: string;
    lang: string;
};

export type NodeInformation = {
    time_registered: number;
    time_modified: number;
    version: string;
    subscriptions: TopicName[];
    publishers: {
        [topic: TopicName]: number; // Last time published
    };
    services: {
        [service: TopicName]: ServiceID;
    };
    ps: NodePS;
};

export type MessageServiceRequest = {
    timings: [string, number][];
    response_topic: ServiceID;
    request_id: UUID;
    args: PublishableData[];
    kwargs: { [key: string]: PublishableData };
};

export type MessageServiceResponse = {
    timings: [string, number][];
    request_id: UUID;
} & (
    | {
          result: "success";
          data: PublishableData;
      }
    | {
          result: "error";
          data: string;
      }
);

export type ServiceHandler = {
    resolvePromise: () => void;
    event: Promise<void>;
} & MessageServiceResponse;

export type MessageTerminateNode = {
    /** The name of the node to terminate */
    node: string;

    /** The reason for termination */
    reason: string;
};
