import { createHash } from "node:crypto";

// The phrase lets a person match the request an approved device shows with the
// one the new browser shows. It is derived from the public request id and is
// not a secret: anyone who can list requests can read it.

const WORDS = `
acorn amber anchor apple arrow aspen atlas autumn badge bamboo banjo basil beacon beaver berry bison
blossom bramble breeze brick bridge brook bucket buffalo button cabin cactus camel candle canoe canyon carbon
carrot castle cedar cello chalk cherry chess cider cinder clover cobalt comet copper coral cotton cougar coyote
cradle crane crater cricket crystal cypress daisy dawn delta desert dingo dolphin domino dragon drum dune eagle
ember falcon fern fiddle figment finch fjord flame flint forest fossil fox galaxy garden garnet gecko geyser
ginger glacier goose granite grape gravel harbor hazel heron hickory honey hornet husky iris island ivory jade
jaguar jasper jungle juniper kayak kelp kettle kiwi koala lagoon lantern lark lava lemon lilac lily linen lizard
llama lobster lotus lynx magnet mango maple marble meadow melon mesa meteor mint mirror moose moss nectar nickel
nutmeg oak oasis ocean olive onion orbit orchid otter owl oyster paddle panda papaya parrot peach pebble pelican
pepper piano pigeon pine planet plum pollen pony poppy prairie pretzel puffin pumpkin quartz quill rabbit radar
raven reed ribbon river robin rocket rose ruby saddle saffron salmon sandal sapphire satin scarf seal sequoia
shadow shell sierra silver sparrow spruce squid star stone summit sunset swan tango tapir thistle thunder tiger
timber toast topaz tulip tundra turtle umber valley velvet violet walnut walrus wave willow window winter wolf
yarrow yeti zebra zephyr zinc acacia almond badger bagel barley birch cashew clay dove elm fig gull hare kite
lime mallow newt opal pear quail rye sage teal thyme vine wren yak yew zest
`.trim().split(/\s+/);

if (WORDS.length !== 256) throw new Error(`the phrase list holds ${WORDS.length} words, expected 256`);

/** Three words, one per byte of the id's digest. Stable for the life of the request. */
export function phraseOf(id) {
  const bytes = createHash("sha256").update(id, "utf8").digest();
  return [bytes[0], bytes[1], bytes[2]].map((byte) => WORDS[byte]).join(" ");
}
