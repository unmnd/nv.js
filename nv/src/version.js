import fs from "fs";

// Get version from package.json
export const __version__ = () => {
    console.log("Getting version number...");
    return JSON.parse(
        fs.readFileSync(new URL("../package.json", import.meta.url))
    ).version;
};
