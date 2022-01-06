const fs = require("fs");
const path = require("path");

// Read the package.json file
const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
);
const __version__ = packageJson.version;

exports.__version__ = __version__;
