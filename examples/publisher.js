// const thing = import("../nv/src/index.js").then(main);

// console.log(thing);

// const Node = require("../nv/src/index.js").Node;

import { Node } from "../nv/src/index.js";

class Publisher extends Node {
    // run() {
    //     // Publish a random choice from the list of words
    //     this.publish("/words", {
    //         word: randomChoice(words),
    //     });
    // }
}

const node = new Publisher({ nodeName: "publisher" });

await node.init();
