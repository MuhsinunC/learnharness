import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { findForbiddenPayload } from "../scripts/payload-guard.mjs";

export function hasRuntimeSdkImport(source: string): boolean {
	const file = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const isSdk = (node: ts.Node | undefined) => node && ts.isStringLiteral(node)
		&& /^@anthropic-ai\/claude-agent-sdk(?:\/|$)/.test(node.text);
	let found = false;
	function visit(node: ts.Node) {
		if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && isSdk(node.moduleSpecifier)
			|| ts.isExportDeclaration(node) && !node.isTypeOnly && isSdk(node.moduleSpecifier)
			|| ts.isCallExpression(node) && ts.isIdentifier(node.expression)
				&& node.expression.text === "require" && isSdk(node.arguments[0])) found = true;
		ts.forEachChild(node, visit);
	}
	visit(file);
	return found;
}

function withTree(test: (root: string) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-payload-"));
	try { test(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe("Claude Code payload guard", () => {
	it("flags direct and nested platform directories, sorted, without descending into them", () => {
		withTree((root) => {
			const direct = "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64";
			const nested = "node_modules/a/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64";
			for (const relative of [direct, nested, `${direct}/node_modules/@anthropic-ai/claude-agent-sdk-x`]) {
				fs.mkdirSync(path.join(root, relative), { recursive: true });
			}
			assert.deepEqual(findForbiddenPayload(root), [direct, nested].sort());
		});
	});

	it("allows clean trees, the base SDK, missing roots, regular files, and skips symlinks", () => {
		withTree((root) => {
			assert.deepEqual(findForbiddenPayload(root), []);
			assert.deepEqual(findForbiddenPayload(path.join(root, "missing")), []);
			const scope = path.join(root, "node_modules", "@anthropic-ai");
			fs.mkdirSync(path.join(scope, "claude-agent-sdk"), { recursive: true });
			assert.deepEqual(findForbiddenPayload(root), []);
			fs.writeFileSync(path.join(scope, "claude-agent-sdk-x"), "file");
			fs.symlinkSync(root, path.join(scope, "claude-agent-sdk-link"), "dir");
			assert.deepEqual(findForbiddenPayload(root), []);
		});
	});

	it("configures the platform exclusion and all three externals", () => {
		const config = fs.readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
		for (const value of ["node_modules/@anthropic-ai/claude-agent-sdk-*/**", "@anthropic-ai/claude-agent-sdk", "@modelcontextprotocol/sdk", "cc-session-io"]) {
			assert.ok(config.includes(`"${value}"`), value);
		}
	});

	it("recognizes runtime imports and exports while allowing erased types and dynamic imports", () => {
		const sdk = "@anthropic-ai/claude-agent-sdk";
		for (const source of [
			`import { query } from "${sdk}"`, `import sdk from "${sdk}"`,
			`import * as sdk from "${sdk}"`, `import { type X } from "${sdk}"`,
			`import "${sdk}"`, `export { x } from "${sdk}"`, `export * from "${sdk}"`,
			`require("${sdk}")`, `import { query } from "${sdk}/sdk"`,
			`import {\n query\n} from\n "${sdk}"`,
		]) assert.equal(hasRuntimeSdkImport(source), true, source);
		for (const source of [
			`import type { X } from "${sdk}"`, `export type { X } from "${sdk}"`,
			`await import("${sdk}")`, `import sdk from "${sdk}-darwin-arm64"`,
			`// import { query } from "${sdk}"`, `const text = 'require("${sdk}")'`,
		]) assert.equal(hasRuntimeSdkImport(source), false, source);
	});

	it("has no runtime SDK imports in src TypeScript files", () => {
		const offenders: string[] = [];
		function walk(dir: string) {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const file = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(file);
				else if (/\.tsx?$/.test(entry.name) && hasRuntimeSdkImport(fs.readFileSync(file, "utf8"))) offenders.push(file);
			}
		}
		walk(fileURLToPath(new URL("../src", import.meta.url)));
		assert.deepEqual(offenders, []);
	});
});
