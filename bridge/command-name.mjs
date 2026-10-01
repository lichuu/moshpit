import { isSea } from "node:sea";

// How a person runs a moshpit command where this code is running: the release
// executable has subcommands, and a checkout runs each module with node.
const CHECKOUT = {
  admin: "node bridge/admin.mjs",
  config: "node bridge/host-config.mjs",
};

/** The command line prefix for `admin` or `config` in usage and hints. */
export const commandFor = (name) => (isSea() ? `moshpit ${name}` : CHECKOUT[name]);
