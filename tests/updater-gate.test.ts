import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isForkBuild } = require("../electron/updater-gate.cjs");

test("fork version suffix disables upstream updates", () => {
	for (const version of ["0.3.7-fork.1", "0.3.7-fork.12", "1.0.0-fork"]) {
		assert.equal(isForkBuild(version), true, version);
	}
	for (const version of ["0.3.7", "0.3.7-beta.1", "0.3.7-forked", "0.3.7-forkx.1", "", undefined]) {
		assert.equal(isForkBuild(version), false, String(version));
	}
});
