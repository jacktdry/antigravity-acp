// Resolve the `agy` executable.
//
// Resolution order:
//   1. $AGY_BIN                  — explicit override for custom builds / CI.
//   2. bin/agy (or bin/agy.exe)  — placed here by the postinstall script,
//      which downloads the pinned compatible binary from GitHub Releases.
//   3. "agy" / "agy.exe"         — falls through to whatever $PATH provides.

import * as fs from "node:fs";
import * as path from "node:path";

/** Path where postinstall deposits the downloaded agy binary.
 *  - npm install: looks in <package-root>/bin/
 *  - compiled SEA: looks next to the executable itself */
export function downloadedAgyPath(): string {
	const exe = process.platform === "win32" ? "agy.exe" : "agy";
	// process.execPath is the compiled binary when running as SEA,
	// or the bun runtime otherwise (in which case bin/ next to package root is correct).
	const isSea =
		!process.execPath.endsWith("bun") && !process.execPath.endsWith("bun.exe");
	if (isSea) {
		return path.join(path.dirname(process.execPath), exe);
	}
	const packageRoot = path.resolve(import.meta.dir, "..", "..");
	return path.join(packageRoot, "bin", exe);
}

/** Resolve the agy binary: explicit $AGY_BIN override → downloaded binary → PATH. */
export function resolveAgyBinary(): string {
	if (process.env.AGY_BIN) return process.env.AGY_BIN;
	const downloaded = downloadedAgyPath();
	try {
		fs.accessSync(downloaded, fs.constants.X_OK);
		return downloaded;
	} catch {
		return process.platform === "win32" ? "agy.exe" : "agy";
	}
}
