// Runs the whole suite as a plain script. This box's Node has a broken `node --test` file globber
// (it throws "Missing internal module 'internal/deps/brace-expansion'" before any test runs), and
// node:test runs every registered test at process exit anyway. Add new test files to this list.
import "./plan.test.ts";
import "./zora.test.ts";
