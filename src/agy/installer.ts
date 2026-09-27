// Shared logic for downloading and installing the agy binary from GitHub Releases.
// Used by both scripts/postinstall.ts (npm install hook) and the server startup
// (auto-install when running as a compiled SEA without agy on PATH).

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Release configuration ─────────────────────────────────────────────────────

export const GITHUB_REPO = "google-antigravity/antigravity-cli";
export const AGY_VERSION = "1.2.12";

export interface Release {
	asset: string;
	sha256: string;
	kind: "tar.gz" | "zip";
}

// Keyed by `${process.platform}-${process.arch}`.
// Update sha256 values together with AGY_VERSION.
export const RELEASES: Record<string, Release> = {
	"darwin-arm64": {
		asset: "agy_cli_mac_arm64.tar.gz",
		sha256: "076a1f0a1874a2843862af9d0eeae751775a84e736e35a84de0dd268069c28cb",
		kind: "tar.gz",
	},
	"darwin-x64": {
		asset: "agy_cli_mac_x64.tar.gz",
		sha256: "1e2f8ed29c05051c61015041d82a50bd95f754c19c8cc7fa8fe35b9f66c9a075",
		kind: "tar.gz",
	},
	"linux-arm64": {
		asset: "agy_cli_linux_arm64.tar.gz",
		sha256: "bd338c9d19ab963d9d2bc027e4e797b470ea84bae02080e4fde4555357ea9444",
		kind: "tar.gz",
	},
	"linux-x64": {
		asset: "agy_cli_linux_x64.tar.gz",
		sha256: "26c7c4c661d6c9beda734fcf305031056a6ea46e697c4533e8151179724e2950",
		kind: "tar.gz",
	},
	"win32-arm64": {
		asset: "agy_cli_windows_arm64.zip",
		sha256: "af3fc21f28a64a04bebec8bfcb865517528548b7763293b195c82a3c1c12422f",
		kind: "zip",
	},
	"win32-x64": {
		asset: "agy_cli_windows_x64.zip",
		sha256: "4e9d3d7895f71917b224f931ad0418081f9234b43202be019a317a6e2185e386",
		kind: "zip",
	},
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function releaseUrl(asset: string): string {
	return `https://github.com/${GITHUB_REPO}/releases/download/${AGY_VERSION}/${asset}`;
}

export function sha256hex(buf: Buffer): string {
	return crypto.createHash("sha256").update(buf).digest("hex");
}

export async function extractTarGz(
	archive: string,
	destDir: string,
): Promise<void> {
	const proc = Bun.spawn(["tar", "-xzf", archive, "-C", destDir], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr as ReadableStream).text();
		throw new Error(`tar exited ${exitCode}: ${stderr.trim()}`);
	}
}

export async function extractZip(
	archive: string,
	destDir: string,
): Promise<void> {
	const proc = Bun.spawn(
		[
			"powershell",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`,
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
	);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr as ReadableStream).text();
		throw new Error(`Expand-Archive exited ${exitCode}: ${stderr.trim()}`);
	}
}

export function findBinary(
	dir: string,
	name: string,
	maxDepth = 2,
): string | null {
	if (maxDepth < 0) return null;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isFile() && entry.name === name) return full;
		if (entry.isDirectory()) {
			const found = findBinary(full, name, maxDepth - 1);
			if (found) return found;
		}
	}
	return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface InstallOptions {
	/** Directory to install the agy binary into. */
	destDir: string;
	/** Log function — use console.log in postinstall, console.error in server (stdout is the ACP wire). */
	log: (msg: string) => void;
	/** Warn function — same distinction as log. */
	warn: (msg: string) => void;
}

/**
 * Download and install the agy binary into opts.destDir.
 *
 * Skips silently when:
 *   - AGY_SKIP_DOWNLOAD=1
 *   - $AGY_BIN is set (user supplies their own binary)
 *   - the binary already exists and is executable in opts.destDir
 *
 * On error, warns and returns without throwing so callers can continue
 * (agy on $PATH is still a valid fallback).
 */
export async function ensureAgy(opts: InstallOptions): Promise<void> {
	const { destDir, log, warn } = opts;

	if (process.env.AGY_SKIP_DOWNLOAD === "1") {
		log("[agy-acp] skipping agy download (AGY_SKIP_DOWNLOAD=1)");
		return;
	}
	if (process.env.AGY_BIN) {
		log(`[agy-acp] using $AGY_BIN=${process.env.AGY_BIN}, skipping download`);
		return;
	}

	const platformKey = `${process.platform}-${process.arch}`;
	const release = RELEASES[platformKey];
	if (!release) {
		warn(
			`[agy-acp] WARN: unsupported platform ${platformKey}. ` +
				`Set $AGY_BIN to your agy binary path.`,
		);
		return;
	}

	const isWin = process.platform === "win32";
	const exeName = isWin ? "agy.exe" : "agy";
	const dest = path.join(destDir, exeName);

	// Already installed and executable — nothing to do.
	try {
		fs.accessSync(dest, fs.constants.X_OK);
		log(`[agy-acp] agy already present (${dest})`);
		return;
	} catch {
		// not present or not executable — fall through to download
	}

	const url = releaseUrl(release.asset);
	log(
		`[agy-acp] agy not found — downloading v${AGY_VERSION} for ${platformKey}...`,
	);

	let resp: Response;
	try {
		resp = await fetch(url, { redirect: "follow" });
	} catch (err) {
		warn(
			`[agy-acp] WARN: network error downloading agy: ${(err as Error).message}\n` +
				`  Set $AGY_BIN to your agy binary path as a workaround.`,
		);
		return;
	}
	if (!resp.ok) {
		warn(
			`[agy-acp] WARN: HTTP ${resp.status} ${resp.statusText} downloading agy from ${url}\n` +
				`  Set $AGY_BIN to your agy binary path as a workaround.`,
		);
		return;
	}

	const archiveBytes = Buffer.from(await resp.arrayBuffer());

	const actual = sha256hex(archiveBytes);
	if (actual !== release.sha256) {
		warn(
			`[agy-acp] WARN: SHA256 mismatch for ${release.asset}\n` +
				`  expected: ${release.sha256}\n` +
				`  got:      ${actual}\n` +
				`  Refusing to install — set $AGY_BIN as a workaround.`,
		);
		return;
	}

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-"));
	try {
		const archivePath = path.join(tmpDir, release.asset);
		fs.writeFileSync(archivePath, archiveBytes);

		const extractDir = path.join(tmpDir, "extracted");
		fs.mkdirSync(extractDir);

		if (release.kind === "tar.gz") {
			await extractTarGz(archivePath, extractDir);
		} else {
			await extractZip(archivePath, extractDir);
		}

		const altExeName = isWin ? "antigravity.exe" : "antigravity";
		const found =
			findBinary(extractDir, exeName) ?? findBinary(extractDir, altExeName);
		if (!found) {
			warn(
				`[agy-acp] WARN: could not locate ${exeName} inside ${release.asset}.\n` +
					`  Extracted contents: ${fs.readdirSync(extractDir).join(", ")}\n` +
					`  Set $AGY_BIN as a workaround.`,
			);
			return;
		}

		fs.mkdirSync(destDir, { recursive: true });
		fs.copyFileSync(found, dest);
		if (!isWin) fs.chmodSync(dest, 0o755);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}

	log(`[agy-acp] agy v${AGY_VERSION} installed → ${dest}`);
}
