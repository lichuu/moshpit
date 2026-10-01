import { z } from "zod";

// The bridge serves the app under `default-src 'self'`, which blocks the
// `Function("")` probe Zod uses to decide whether it can JIT. Telling it up
// front keeps a CSP violation off the console on every load; Zod lands on
// this same interpreted path either way. This is its own module, imported
// first by main.tsx, because modules evaluate in import order: set in
// main.tsx's body, it ran after a module that parses at import time had
// already fired the probe.
z.config({ jitless: true });
