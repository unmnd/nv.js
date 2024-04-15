import { readFileSync } from "fs";
import { join } from "path";

let version: string | undefined;
try {
    version = JSON.parse(
        readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
    ).version;
} catch (e) {
    version = JSON.parse(
        readFileSync(join(__dirname, "..", "package.json"), "utf8"),
    ).version;
}
export const __version__ = version;
