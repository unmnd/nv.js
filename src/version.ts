import { readFileSync } from "fs";

export const __version__ = JSON.parse(
    readFileSync(
        __dirname +
            (process.env.NODE_ENV === "production"
                ? "/../../package.json"
                : "/../package.json"),
        "utf8",
    ),
).version;
