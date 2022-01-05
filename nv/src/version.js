import fs from "fs";

// Get version from package.json
export const __version__ = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url))
).version;
