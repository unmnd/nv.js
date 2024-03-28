import { readFileSync } from "fs";

export const __version__ = JSON.parse(
    readFileSync(__dirname + "/../package.json", "utf8")
).version;
