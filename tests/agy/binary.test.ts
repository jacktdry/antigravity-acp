import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { downloadedAgyPath, resolveAgyBinary } from "../../src/agy/binary";

describe("agy binary resolution", () => {
	const _originalExecPath = process.execPath;
	const _originalPlatform = process.platform;
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
		mock.restore();
	});

	test("downloadedAgyPath should return a valid path", () => {
		const result = downloadedAgyPath();
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result.includes("agy")).toBe(true);
	});

	test("resolveAgyBinary should use AGY_BIN even when a downloaded binary exists", () => {
		process.env.AGY_BIN = "/custom/path/to/agy";

		const access = spyOn(fs, "accessSync").mockImplementation(() => {});

		const resolved = resolveAgyBinary();
		expect(resolved).toBe("/custom/path/to/agy");
		expect(access).not.toHaveBeenCalled();
	});

	test("resolveAgyBinary should fallback to 'agy' or 'agy.exe' if AGY_BIN is not set", () => {
		delete process.env.AGY_BIN;

		spyOn(fs, "accessSync").mockImplementation(() => {
			throw new Error("not found");
		});

		const resolved = resolveAgyBinary();
		const expected = process.platform === "win32" ? "agy.exe" : "agy";
		expect(resolved).toBe(expected);
	});

	test("resolveAgyBinary should return downloaded path if it exists", () => {
		spyOn(fs, "accessSync").mockImplementation(() => {});

		const resolved = resolveAgyBinary();
		expect(resolved).toBe(downloadedAgyPath());
	});
});
