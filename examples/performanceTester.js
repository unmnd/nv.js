const crypto = require("crypto");

const { Node } = require("../src/index");

const testData = {
    smallString: "This is a small text message",
    mediumString:
        "This is a medium text message. It contains more characters than the previous small string, but in the grand scheme of data transfer it's still pretty small. Following this message is a short poem to further pad this data. According to all known laws of aviation, there is no way a bee should be able to fly. Its wings are too small to get its fat little body off the ground. The bee, of course, flies anyway because bees don't care what humans think is impossible. Yellow, black. Yellow, black. Yellow, black. Yellow, black. Ooh, black and yellow! Let's shake it up a little. Barry! Breakfast is ready! Ooming! Hang on a second. Hello?",
    float: 1.23456789,
    integer: 123456789,
    object: {
        key1: "value1",
        key2: "value2",
        key3: 11223344,
        key4: true,
        key5: false,
    },
    array: [
        "value1",
        "value2",
        "value3",
        "value4",
        "value5",
        "value6",
        "value7",
        "value8",
        "value9",
        "value10",
    ],
    OneMBofRandomBytes: crypto.randomBytes(1024 * 1024),
    TenMBofRandomBytes: crypto.randomBytes(1024 * 1024 * 10),
};

class PerformanceTester extends Node {
    async init() {
        await super.init();

        // Set up the subscriber
        this.subscriber = this.createSubscription(
            "performance_test_topic",
            this.subscriberCallback.bind(this)
        );

        this.startTimes = {};
        this.durations = {};

        // Keep track of which test data we're sending
        this.testDataIndex = 0;

        // Send the first message
        this.sendTestData();
    }

    sendTestData() {
        // Get current data entry
        const dataKey = Object.keys(testData)[this.testDataIndex];

        // If there's no more data, conclude the test
        if (!dataKey) {
            this.log.info("\n\n---\n\nDurations:");

            for (const [dataSize, duration] of Object.entries(this.durations)) {
                // Round to 2 decimal places
                this.log.info(`${dataSize}: ${duration.toFixed(2)}ms`);
            }

            return;
        }

        const data = testData[dataKey];

        this.log.debug("Sending message: " + dataKey);

        const startTime = process.hrtime();

        this.startTimes[dataKey] = startTime[0] * 1000 + startTime[1] / 1000000;

        this.publish("performance_test_topic", data);
    }

    subscriberCallback(msg) {
        const finishTime = process.hrtime();

        this.log.debug("Received message");

        // Get key of test data
        const dataKey = Object.keys(testData)[this.testDataIndex];

        if (!dataKey) {
            throw new Error("Received unexpected message");
        }

        this.durations[dataKey] =
            finishTime[0] * 1000 +
            finishTime[1] / 1000000 -
            this.startTimes[dataKey];

        this.testDataIndex++;
        this.sendTestData();
    }
}

// Create the node
const node = new PerformanceTester({
    nodeName: "performance_tester_node",
    skipRegistration: true,
});
node.init();
