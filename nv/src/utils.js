/*
Extra utilities and helper functions.

Callum Morrison, 2021
UNMND, Ltd. 2021
<callum@unmnd.com>

All Rights Reserved
*/

/**
 * Generate a random human-readable name.
 *
 * @returns {String} A random name.
 */
function generateName() {
    const adjectives = [
        "defiant",
        "homeless",
        "adorable",
        "delightful",
        "homely",
        "quaint",
        "adventurous",
        "depressed",
        "horrible",
        "aggressive",
        "determined",
        "hungry",
        "real",
        "agreeable",
        "different",
        "hurt",
        "relieved",
        "alert",
        "difficult",
        "repulsive",
        "alive",
        "disgusted",
        "ill",
        "rich",
        "amused",
        "distinct",
        "important",
        "angry",
        "disturbed",
        "impossible",
        "scary",
        "annoyed",
        "dizzy",
        "inexpensive",
        "selfish",
        "annoying",
        "doubtful",
        "innocent",
        "shiny",
        "anxious",
        "drab",
        "inquisitive",
        "shy",
        "arrogant",
        "dull",
        "itchy",
        "silly",
        "ashamed",
        "sleepy",
        "attractive",
        "eager",
        "jealous",
        "smiling",
        "average",
        "easy",
        "jittery",
        "smoggy",
        "awful",
        "elated",
        "jolly",
        "sore",
        "elegant",
        "joyous",
        "sparkling",
        "bad",
        "embarrassed",
        "splendid",
        "beautiful",
        "enchanting",
        "kind",
        "spotless",
        "better",
        "encouraging",
        "stormy",
        "bewildered",
        "energetic",
        "lazy",
        "strange",
        "black",
        "enthusiastic",
        "light",
        "stupid",
        "bloody",
        "envious",
        "lively",
        "successful",
        "blue",
        "evil",
        "lonely",
        "super",
        "blue",
        "eyed",
        "excited",
        "long",
        "blushing",
        "expensive",
        "lovely",
        "talented",
        "bored",
        "exuberant",
        "lucky",
        "tame",
        "brainy",
        "tender",
        "brave",
        "fair",
        "magnificent",
        "tense",
        "breakable",
        "faithful",
        "misty",
        "terrible",
        "bright",
        "famous",
        "modern",
        "tasty",
        "busy",
        "fancy",
        "motionless",
        "thankful",
        "fantastic",
        "muddy",
        "thoughtful",
        "calm",
        "fierce",
        "mushy",
        "thoughtless",
        "careful",
        "filthy",
        "mysterious",
        "tired",
        "cautious",
        "fine",
        "tough",
        "charming",
        "foolish",
        "nasty",
        "troubled",
        "cheerful",
        "fragile",
        "naughty",
        "clean",
        "frail",
        "nervous",
        "ugliest",
        "clear",
        "frantic",
        "nice",
        "ugly",
        "clever",
        "friendly",
        "nutty",
        "uninterested",
        "cloudy",
        "frightened",
        "unsightly",
        "clumsy",
        "funny",
        "obedient",
        "unusual",
        "colorful",
        "obnoxious",
        "upset",
        "combative",
        "gentle",
        "odd",
        "uptight",
        "comfortable",
        "gifted",
        "old",
        "fashioned",
        "concerned",
        "glamorous",
        "open",
        "vast",
        "condemned",
        "gleaming",
        "outrageous",
        "victorious",
        "confused",
        "glorious",
        "outstanding",
        "vivacious",
        "cooperative",
        "good",
        "courageous",
        "gorgeous",
        "panicky",
        "wandering",
        "crazy",
        "graceful",
        "perfect",
        "weary",
        "creepy",
        "grieving",
        "plain",
        "wicked",
        "crowded",
        "grotesque",
        "pleasant",
        "wide",
        "eyed",
        "cruel",
        "grumpy",
        "poised",
        "wild",
        "curious",
        "poor",
        "witty",
        "cute",
        "handsome",
        "powerful",
        "worrisome",
        "happy",
        "precious",
        "worried",
        "dangerous",
        "healthy",
        "prickly",
        "wrong",
        "dark",
        "helpful",
        "proud",
        "dead",
        "helpless",
        "putrid",
        "zany",
        "defeated",
        "hilarious",
        "puzzled",
        "zealous",
    ];
    const nouns = [
        "actor",
        "gold",
        "painting",
        "advertisement",
        "grass",
        "parrot",
        "afternoon",
        "greece",
        "pencil",
        "airport",
        "guitar",
        "piano",
        "ambulance",
        "hair",
        "pillow",
        "animal",
        "hamburger",
        "pizza",
        "answer",
        "helicopter",
        "planet",
        "apple",
        "helmet",
        "plastic",
        "army",
        "holiday",
        "honey",
        "potato",
        "balloon",
        "horse",
        "queen",
        "banana",
        "hospital",
        "quill",
        "battery",
        "house",
        "rain",
        "beach",
        "hydrogen",
        "rainbow",
        "beard",
        "ice",
        "raincoat",
        "bed",
        "insect",
        "refrigerator",
        "insurance",
        "restaurant",
        "boy",
        "iron",
        "river",
        "branch",
        "island",
        "rocket",
        "breakfast",
        "jackal",
        "room",
        "brother",
        "jelly",
        "rose",
        "camera",
        "jewellery",
        "candle",
        "sandwich",
        "car",
        "juice",
        "school",
        "caravan",
        "kangaroo",
        "scooter",
        "carpet",
        "king",
        "shampoo",
        "cartoon",
        "kitchen",
        "shoe",
        "kite",
        "soccer",
        "church",
        "knife",
        "spoon",
        "crayon",
        "lamp",
        "stone",
        "crowd",
        "lawyer",
        "sugar",
        "daughter",
        "leather",
        "death",
        "library",
        "teacher",
        "lighter",
        "telephone",
        "diamond",
        "lion",
        "television",
        "dinner",
        "lizard",
        "tent",
        "disease",
        "lock",
        "doctor",
        "tomato",
        "dog",
        "lunch",
        "toothbrush",
        "dream",
        "machine",
        "traffic",
        "dress",
        "magazine",
        "train",
        "easter",
        "magician",
        "truck",
        "egg",
        "eggplant",
        "market",
        "umbrella",
        "match",
        "van",
        "elephant",
        "microphone",
        "vase",
        "energy",
        "monkey",
        "vegetable",
        "engine",
        "morning",
        "vulture",
        "motorcycle",
        "wall",
        "evening",
        "nail",
        "whale",
        "eye",
        "napkin",
        "window",
        "family",
        "needle",
        "wire",
        "nest",
        "xylophone",
        "fish",
        "yacht",
        "flag",
        "night",
        "yak",
        "flower",
        "notebook",
        "zebra",
        "football",
        "ocean",
        "zoo",
        "forest",
        "oil",
        "garden",
        "fountain",
        "orange",
        "gas",
        "oxygen",
        "girl",
        "furniture",
        "oyster",
        "glass",
        "garage",
        "ghost",
    ];

    function randomChoice(arr) {
        const index = Math.floor(Math.random() * arr.length);
        return arr[index];
    }

    return randomChoice(adjectives) + "_" + randomChoice(nouns);
}

/**
 * Sleep for a given number of milliseconds.
 *
 * @param {Number} duration The number of milliseconds to sleep.
 *
 * @returns {Promise} A promise that resolves after the given number of
 * milliseconds.
 */
function sleep(duration) {
    return new Promise((resolve) => setTimeout(resolve, duration));
}

exports.generateName = generateName;
exports.sleep = sleep;
