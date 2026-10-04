import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Root index.ts (CLI args & main logic)", () => {
	const originalArgv = process.argv;

	afterEach(() => {
		process.argv = originalArgv;
		mock.restore();
	});

	test("should exit with 0 and print version for -v flag", async () => {
		const proc = Bun.spawn(["bun", "run", "index.ts", "-v"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);

		const stdout = await new Response(proc.stdout).text();
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
	});

	test("should exit with 0 and print version for --version flag", async () => {
		const proc = Bun.spawn(["bun", "run", "index.ts", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);

		const stdout = await new Response(proc.stdout).text();
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
	});

	test("unhandled rejection logging", async () => {
		const script = `
			import { mock } from "bun:test";
			mock.module("./src/acp/server", () => ({ runAcp: () => ({ connection: { closed: new Promise(() => {}) } }) }));
			mock.module("./src/agy/installer", () => ({ ensureAgy: async () => {} }));
			await import("./index.ts");
			Promise.reject(new Error("Test unhandled rejection"));
			setTimeout(() => process.exit(0), 50);
		`;
		const testFile = path.join(process.cwd(), "test-unhandled.ts");
		fs.writeFileSync(testFile, script);
		const proc = Bun.spawn(["bun", "run", "test-unhandled.ts"], {
			stderr: "pipe",
			stdout: "pipe",
		});
		const _exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		fs.unlinkSync(testFile);

		expect(stderr).toContain("[agy-acp] unhandled rejection:");
		expect(stderr).toContain("Test unhandled rejection");
	});

	test("ensureAgy is called if fs.accessSync fails", async () => {
		const script = `
			import { mock } from "bun:test";
			mock.module("./src/agy/binary", () => ({ downloadedAgyPath: () => "/does/not/exist/ever" }));
			mock.module("./src/agy/installer", () => ({ ensureAgy: async () => { console.error("CALLED_ENSURE_AGY"); } }));
			mock.module("./src/acp/server", () => ({ runAcp: () => ({ connection: { closed: new Promise(() => {}) } }) }));
			await import("./index.ts");
			setTimeout(() => process.exit(0), 50);
		`;
		const testFile = path.join(process.cwd(), "test-ensureAgy.ts");
		fs.writeFileSync(testFile, script);
		const proc = Bun.spawn(["bun", "run", "test-ensureAgy.ts"], {
			stderr: "pipe",
		});
		await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		fs.unlinkSync(testFile);

		expect(stderr).toContain("CALLED_ENSURE_AGY");
	});

	test("ensureAgy is skipped if fs.accessSync succeeds", async () => {
		const script = `
			import { mock } from "bun:test";
			mock.module("./src/agy/binary", () => ({ downloadedAgyPath: () => process.execPath })); // bun is definitely executable
			mock.module("./src/agy/installer", () => ({ ensureAgy: async () => { console.error("CALLED_ENSURE_AGY"); } }));
			mock.module("./src/acp/server", () => ({ runAcp: () => ({ connection: { closed: new Promise(() => {}) } }) }));
			await import("./index.ts");
			setTimeout(() => process.exit(0), 50);
		`;
		const testFile = path.join(process.cwd(), "test-ensureAgy-skip.ts");
		fs.writeFileSync(testFile, script);
		const proc = Bun.spawn(["bun", "run", "test-ensureAgy-skip.ts"], {
			stderr: "pipe",
		});
		await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		fs.unlinkSync(testFile);

		expect(stderr).not.toContain("CALLED_ENSURE_AGY");
	});

	test("fatal error catch block triggers process.exit(1)", async () => {
		const script = `
			import { mock } from "bun:test";
			mock.module("./src/acp/server", () => ({ runAcp: () => { throw new Error("Test fatal error"); } }));
			mock.module("./src/agy/installer", () => ({ ensureAgy: async () => {} }));
			await import("./index.ts");
		`;
		const testFile = path.join(process.cwd(), "test-fatal.ts");
		fs.writeFileSync(testFile, script);
		const proc = Bun.spawn(["bun", "run", "test-fatal.ts"], {
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		fs.unlinkSync(testFile);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("[agy-acp] fatal: Test fatal error");
	});
});
