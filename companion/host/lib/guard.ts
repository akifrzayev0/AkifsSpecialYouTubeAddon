// lib/guard.ts - import this FIRST in the entry module (host.ts).
// ES modules evaluate dependencies depth-first in import order, so a statement in
// host.ts itself runs only after every imported module has already executed.
// Importing this module first re-routes console.* before any other module's
// top-level code could print to stdout, which is the native-messaging channel.
import { hijackConsole } from "./log.ts";
hijackConsole();
