// Non-production subprocess fixture. Never enables an AGY prompt launch.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { readPrivateState, validatePrivateState } from "../store/private-state";
import {
	evaluateNativePermissionHook,
	type NativeHookOutput,
	type NativePermissionBinding,
	type NativePermissionProvider,
	nativePermissionHookConfig,
} from "./native-permission-policy";

const LIMIT = 256 * 1024;
const FLAG = "--agentdock-native-hook";
const invalid = () => new Error("Invalid native hook fixture");
const deny = (): NativeHookOutput => ({
	decision: "deny",
	reason: "AGY_NATIVE_CORE_UNAVAILABLE",
});

export interface TrustedHookCommand {
	executable: string;
	args: string[];
}
interface FixtureConfig {
	version: 1;
	mode: "subprocess-fixture";
	binding: NativePermissionBinding;
	provider: TrustedHookCommand;
	timeoutMs: number;
}

function supported(): void {
	if (!["darwin", "linux"].includes(process.platform) || !process.getuid)
		throw invalid();
}

function optIn(env: NodeJS.ProcessEnv): void {
	supported();
	if (
		env.AGY_ACP_NATIVE_HOOK !== "fixture-v1" ||
		env.AGY_ACP_AUTO_APPROVE !== "0" ||
		env.AGY_ACP_CHILD_ISOLATION !== "required" ||
		env.AGY_EXTRA_ARGS?.trim()
	)
		throw invalid();
}

/** Reject links, writable foreign ancestors, and mutable-by-other executable. */
function trustedCommand(command: TrustedHookCommand): void {
	if (
		!command ||
		typeof command.executable !== "string" ||
		!path.isAbsolute(command.executable) ||
		path.resolve(command.executable) !== command.executable ||
		!Array.isArray(command.args) ||
		!command.args.every((v) => typeof v === "string" && !/[\0\r\n]/.test(v)) ||
		/[\0\r\n]/.test(command.executable)
	)
		throw invalid();
	// Treat executable ancestors as trusted directories, not as private HOME leaves.
	validatePrivateState(
		path.join(path.dirname(command.executable), ".agy-hook-unused-leaf"),
		false,
	);
	const stat = fs.lstatSync(command.executable);
	if (
		!stat.isFile() ||
		stat.nlink !== 1 ||
		(stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
		(stat.mode & 0o022) !== 0 ||
		(stat.mode & 0o111) === 0
	)
		throw invalid();
}

function validateConfig(config: FixtureConfig): void {
	if (
		config?.version !== 1 ||
		config.mode !== "subprocess-fixture" ||
		!Number.isSafeInteger(config.timeoutMs) ||
		config.timeoutMs <= 0 ||
		config.timeoutMs > 25_000
	)
		throw invalid();
	const b = config.binding;
	if (
		!b ||
		![
			b.ownerId,
			b.adapterIncarnation,
			b.sessionId,
			b.turnId,
			b.policyRevision,
			b.conversationId,
		].every((v) => typeof v === "string" && !!v) ||
		!Array.isArray(b.workspacePaths) ||
		!b.workspacePaths.length ||
		!b.workspacePaths.every((v) => typeof v === "string" && path.isAbsolute(v))
	)
		throw invalid();
	trustedCommand(config.provider);
}

/** New empty private HOME only; no auth, global config, workspace hooks or merges. */
export function installNativeHookFixture(
	parent: string,
	hook: TrustedHookCommand,
	binding: NativePermissionBinding,
	provider: TrustedHookCommand,
	options: { env: NodeJS.ProcessEnv; timeoutMs?: number },
): { home: string; command: TrustedHookCommand; env: Record<string, string> } {
	optIn(options.env);
	if (!path.isAbsolute(parent) || path.resolve(parent) !== parent)
		throw invalid();
	validatePrivateState(parent, false);
	if (!fs.statSync(parent).isDirectory()) throw invalid();
	trustedCommand(hook);
	const config: FixtureConfig = {
		version: 1,
		mode: "subprocess-fixture",
		binding,
		provider,
		timeoutMs: options.timeoutMs ?? 1000,
	};
	validateConfig(config);
	const home = fs.mkdtempSync(path.join(parent, "agy-native-hook-"));
	try {
		fs.mkdirSync(path.join(home, "bin"), { mode: 0o700 });
		fs.mkdirSync(path.join(home, ".gemini"), { mode: 0o700 });
		fs.mkdirSync(path.join(home, ".gemini/config"), { mode: 0o700 });
		const manifest = path.join(home, "native-hook.json");
		fs.writeFileSync(manifest, JSON.stringify(config), {
			flag: "wx",
			mode: 0o600,
		});
		const invocation = nativePermissionHookConfig(hook.executable, [
			...hook.args,
			FLAG,
			manifest,
		]);
		const launcher = path.join(home, "bin/native-hook");
		const command = invocation["agentdock-native-permission"].PreToolUse[0]?.hooks[0]?.command;
		if (!command) throw invalid();
		fs.writeFileSync(
			launcher,
			`#!/bin/sh\nexec ${command} "$@"\n`,
			{ flag: "wx", mode: 0o700 },
		);
		fs.writeFileSync(
			path.join(home, ".gemini/config/hooks.json"),
			JSON.stringify(nativePermissionHookConfig(launcher)),
			{ flag: "wx", mode: 0o600 },
		);
		return {
			home,
			command: { executable: launcher, args: [] },
			env: {
				HOME: home,
				AGY_ACP_NATIVE_HOOK: "fixture-v1",
				AGY_ACP_AUTO_APPROVE: "0",
				AGY_ACP_CHILD_ISOLATION: "required",
			},
		};
	} catch {
		fs.rmSync(home, { recursive: true, force: true });
		throw invalid();
	}
}

/** One bounded JSON exchange; no shell, env credentials, HTTP or grant cache. */
export function subprocessNativeProvider(
	command: TrustedHookCommand,
): NativePermissionProvider {
	return (request, signal) =>
		new Promise((resolve, reject) => {
			try {
				supported();
				trustedCommand(command);
			} catch {
				reject(invalid());
				return;
			}
			if (signal.aborted) {
				reject(invalid());
				return;
			}
			const child = spawn(command.executable, command.args, {
				detached: true,
				stdio: ["pipe", "pipe", "ignore"],
				env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin" },
			});
			let size = 0;
			const chunks: Buffer[] = [];
			let failed = false;
			const stop = () => {
				failed = true;
				if (child.pid) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {}
				}
			};
			signal.addEventListener("abort", stop, { once: true });
			child.stdin.on("error", stop);
			child.stdout.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > LIMIT) stop();
				else chunks.push(chunk);
			});
			child.on("error", () => {
				failed = true;
			});
			// exit precedes close: descendants may still hold the stdout pipe open.
			child.on("exit", () => {
				if (child.pid) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {}
				}
			});
			child.on("close", (code) => {
				signal.removeEventListener("abort", stop);
				if (failed || signal.aborted || code !== 0) {
					reject(invalid());
					return;
				}
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch {
					reject(invalid());
				}
			});
			child.stdin.end(JSON.stringify(request));
		});
}

async function readInput(signal: AbortSignal): Promise<string> {
	let size = 0;
	const chunks: Buffer[] = [];
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			process.stdin.pause();
			process.stdin.removeListener("data", data);
			process.stdin.removeListener("end", end);
			process.stdin.removeListener("error", abort);
			process.stdin.removeListener("close", abort);
			signal.removeEventListener("abort", abort);
		};
		const abort = () => {
			cleanup();
			reject(invalid());
		};
		const data = (chunk: Buffer) => {
			size += chunk.length;
			if (size > LIMIT) abort();
			else chunks.push(chunk);
		};
		const end = () => {
			cleanup();
			resolve(Buffer.concat(chunks).toString("utf8"));
		};
		signal.addEventListener("abort", abort, { once: true });
		process.stdin
			.on("data", data)
			.once("end", end)
			.once("error", abort)
			.once("close", abort);
		if (signal.aborted) abort();
	});
}

/** Runs before installer/ACP. Invalid fixture invocation emits only fixed deny. */
export async function runNativeHookFromArgs(): Promise<boolean> {
	if (!process.argv.slice(2).some((arg) => arg.startsWith(FLAG))) return false;
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let output = deny();
	try {
		optIn(process.env);
		const args = process.argv.slice(2);
		if (args.length !== 2 || args[0] !== FLAG) throw invalid();
		const file = args[1];
		if (!file || !path.isAbsolute(file) || path.resolve(file) !== file)
			throw invalid();
		if (fs.lstatSync(file).size > LIMIT) throw invalid();
		const raw = readPrivateState(file);
		if (!raw || Buffer.byteLength(raw) > LIMIT) throw invalid();
		const config: FixtureConfig = JSON.parse(raw);
		validateConfig(config);
		timer = setTimeout(cancel, config.timeoutMs);
		const input = await readInput(controller.signal);
		clearTimeout(timer);
		output = await evaluateNativePermissionHook(
			input,
			config.binding,
			subprocessNativeProvider(config.provider),
			{ timeoutMs: config.timeoutMs, signal: controller.signal },
		);
	} catch {
		output = deny();
	} finally {
		clearTimeout(timer);
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
	process.stdout.write(`${JSON.stringify(output)}\n`);
	return true;
}
