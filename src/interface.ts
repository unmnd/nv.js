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

export type TopicName = string;
export type ServiceID = `srv://${UUID}`;

export type SubscriptionCallback = (data: any) => void;
export type ServiceRequestObject = {
    timings: [string, number][];
    resolvePromise: () => void;
    event: Promise<void>;
} & (
    | {
          result: "success";
          data: any;
      }
    | {
          result: "error";
          error: string;
      }
);
