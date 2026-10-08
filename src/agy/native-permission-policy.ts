// Experimental hook/provider contract only. No AGY launch path enables it.
import { createHash, randomUUID } from "node:crypto";

export type NativePermissionDiagnostic =
	| "AGY_NATIVE_POLICY_INVALID"
	| "AGY_NATIVE_EXTRA_ARGS_FORBIDDEN"
	| "AGY_NATIVE_APPROVAL_UNAVAILABLE"
	| "AGY_NATIVE_HOOK_INPUT_INVALID"
	| "AGY_NATIVE_HOOK_TOOL_UNSUPPORTED"
	| "AGY_NATIVE_CORE_UNAVAILABLE"
	| "AGY_NATIVE_CORE_RESPONSE_INVALID"
	| "AGY_NATIVE_CORE_DENIED"
	| "AGY_NATIVE_CORE_APPROVAL_PENDING"
	| "AGY_NATIVE_CORE_TIMEOUT"
	| "AGY_NATIVE_CORE_CANCELLED"
	| "AGY_NATIVE_CORE_ALLOWED";

export class NativePermissionError extends Error {
	constructor(
		readonly code: NativePermissionDiagnostic,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "NativePermissionError";
	}
}

export type NativePermissionPolicy =
	| { mode: "legacy"; authority: "agy" }
	| {
			mode: "blocked";
			authority: "core-required";
			code: "AGY_NATIVE_APPROVAL_UNAVAILABLE";
	  };

export function nativePermissionPolicy(
	value = process.env.AGY_ACP_AUTO_APPROVE,
): NativePermissionPolicy {
	if (value === undefined) return { mode: "legacy", authority: "agy" };
	if (value !== "0")
		throw new NativePermissionError(
			"AGY_NATIVE_POLICY_INVALID",
			"Invalid AGY_ACP_AUTO_APPROVE",
		);
	return {
		mode: "blocked",
		authority: "core-required",
		code: "AGY_NATIVE_APPROVAL_UNAVAILABLE",
	};
}

export function assertNativeExtraArgsAllowed(tokens: readonly string[]): void {
	if (nativePermissionPolicy().mode === "blocked" && tokens.length)
		throw new NativePermissionError(
			"AGY_NATIVE_EXTRA_ARGS_FORBIDDEN",
			"AGY_EXTRA_ARGS is forbidden with AGY_ACP_AUTO_APPROVE=0",
		);
}

/** Core supplies this binding out of band; hook stdin is never authority. */
export interface NativePermissionBinding {
	ownerId: string;
	adapterIncarnation: string;
	sessionId: string;
	turnId: string;
	policyRevision: string;
	conversationId: string;
	workspacePaths: string[];
}

export interface NativePermissionRequest {
	version: 1;
	requestId: string;
	operationDigest: string;
	binding: NativePermissionBinding;
	stepIdx: number;
	toolCall: { name: string; args: Record<string, unknown> };
}

export interface NativePermissionResponse {
	requestId: string;
	operationDigest: string;
	decision: "allow" | "ask" | "deny";
	expiresAt: number;
}

// Real providers must authenticate Core and validate the live binding/revision.
export type NativePermissionProvider = (
	request: NativePermissionRequest,
	signal: AbortSignal,
) => Promise<unknown>;

export interface NativeHookOutput {
	decision: "allow" | "deny";
	/** Fixed code only: no paths, command text, provider reasons or credentials. */
	reason: NativePermissionDiagnostic;
}

const SUPPORTED_TOOLS = new Set([
	"run_command",
	"view_file",
	"write_to_file",
	"replace_file_content",
	"multi_replace_file_content",
	"list_dir",
	"find_by_name",
	"grep_search",
]);

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (object(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

const deny = (reason: NativePermissionDiagnostic): NativeHookOutput => ({
	decision: "deny",
	reason,
});

/** Mock-testable pre-execution gate; never executes a tool or grants AGY rules. */
export async function evaluateNativePermissionHook(
	raw: string,
	binding: NativePermissionBinding,
	provider?: NativePermissionProvider,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<NativeHookOutput> {
	let request: NativePermissionRequest;
	try {
		if (Buffer.byteLength(raw) > 256 * 1024) throw new Error();
		const input: unknown = JSON.parse(raw);
		if (
			!object(input) ||
			!object(input.toolCall) ||
			typeof input.toolCall.name !== "string" ||
			!object(input.toolCall.args) ||
			!Number.isSafeInteger(input.stepIdx) ||
			(input.stepIdx as number) < 0 ||
			input.conversationId !== binding.conversationId ||
			!binding.conversationId ||
			![
				binding.ownerId,
				binding.adapterIncarnation,
				binding.sessionId,
				binding.turnId,
				binding.policyRevision,
			].every((v) => typeof v === "string" && v.length > 0) ||
			!Array.isArray(binding.workspacePaths) ||
			!binding.workspacePaths.length ||
			!binding.workspacePaths.every(
				(v) => typeof v === "string" && v.startsWith("/"),
			) ||
			canonical(input.workspacePaths) !== canonical(binding.workspacePaths)
		)
			throw new Error();
		if (!SUPPORTED_TOOLS.has(input.toolCall.name))
			return deny("AGY_NATIVE_HOOK_TOOL_UNSUPPORTED");
		// Detach from caller mutation while awaiting the provider.
		const operation = JSON.parse(
			JSON.stringify({
				version: 1,
				binding,
				stepIdx: input.stepIdx,
				toolCall: input.toolCall,
			}),
		);
		request = {
			...operation,
			requestId: randomUUID(),
			operationDigest: createHash("sha256")
				.update(canonical(operation))
				.digest("hex"),
		};
	} catch {
		return deny("AGY_NATIVE_HOOK_INPUT_INVALID");
	}
	if (options.signal?.aborted) return deny("AGY_NATIVE_CORE_CANCELLED");
	if (!provider) return deny("AGY_NATIVE_CORE_UNAVAILABLE");
	const timeoutMs = options.timeoutMs ?? 1000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 25_000)
		return deny("AGY_NATIVE_HOOK_INPUT_INVALID");
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancelled = false;
	let timedOut = false;
	const cancel = () => {
		cancelled = true;
		controller.abort();
	};
	options.signal?.addEventListener("abort", cancel, { once: true });
	// Snapshot expected response identity; a provider cannot rewrite the request.
	const { requestId, operationDigest } = request;
	try {
		const interrupted = new Promise<never>((_, reject) => {
			controller.signal.addEventListener("abort", () => reject(new Error()), {
				once: true,
			});
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);
		});
		const response = await Promise.race([
			Promise.resolve().then(() => provider(request, controller.signal)),
			interrupted,
		]);
		if (cancelled || options.signal?.aborted)
			return deny("AGY_NATIVE_CORE_CANCELLED");
		if (timedOut) return deny("AGY_NATIVE_CORE_TIMEOUT");
		if (
			!object(response) ||
			response.requestId !== requestId ||
			response.operationDigest !== operationDigest ||
			typeof response.expiresAt !== "number" ||
			!Number.isFinite(response.expiresAt) ||
			response.expiresAt <= Date.now()
		)
			return deny("AGY_NATIVE_CORE_RESPONSE_INVALID");
		if (response.decision === "allow")
			return { decision: "allow", reason: "AGY_NATIVE_CORE_ALLOWED" };
		if (response.decision === "deny") return deny("AGY_NATIVE_CORE_DENIED");
		if (response.decision === "ask")
			return deny("AGY_NATIVE_CORE_APPROVAL_PENDING");
		return deny("AGY_NATIVE_CORE_RESPONSE_INVALID");
	} catch {
		return deny(
			cancelled
				? "AGY_NATIVE_CORE_CANCELLED"
				: timedOut
					? "AGY_NATIVE_CORE_TIMEOUT"
					: "AGY_NATIVE_CORE_UNAVAILABLE",
		);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
	}
}

/** POSIX configuration fixture, not installed into any running child HOME.
 * Core must provision a trusted executable and protect configuration from tools.
 */
export function nativePermissionHookConfig(
	trustedExecutable: string,
	trustedArgs: readonly string[] = [],
) {
	if (
		!trustedExecutable.startsWith("/") ||
		[trustedExecutable, ...trustedArgs].some((v) => /[\0\r\n]/.test(v))
	)
		throw new NativePermissionError(
			"AGY_NATIVE_POLICY_INVALID",
			"Invalid native hook executable",
		);
	return {
		"agentdock-native-permission": {
			enabled: true,
			PreToolUse: [
				{
					matcher: "*",
					hooks: [
						{
							type: "command",
							command: [trustedExecutable, ...trustedArgs]
								.map((v) => `'${v.replaceAll("'", "'\\''")}'`)
								.join(" "),
							timeout: 30,
						},
					],
				},
			],
		},
	};
}
