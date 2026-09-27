/** In-memory session state for a live ACP session. */
export interface Session {
	/** agy conversation id this session is bound to, or null until first prompt. */
	conversationId: string | null;
	/** Highest step idx already streamed/replayed to the client. */
	lastStepIdx: number;
	/** Selected model id, or null for agy's default. */
	modelId: string | null;
	/** Permission mode (e.g. "plan"), or null for default. */
	permissionMode: string | null;
	/** Whether sandbox mode with terminal restrictions is enabled. */
	sandbox?: boolean;
	/** Working directory for this session (from session/new cwd param). */
	cwd: string;
	/** Extra workspace roots beyond cwd (from additionalDirectories param). */
	additionalDirs: string[];
	/** Human-readable title, set from conversation title updates. */
	title: string | null;
	/** ISO 8601 timestamp of last activity. */
	updatedAt: string;
}

/** The persisted subset of a session, written to sessions.json. */
export type StoredSession = Session;

/** Create a fresh, unbound session. */
export function newSession(
	cwd: string,
	additionalDirs: string[] = [],
): Session {
	return {
		conversationId: null,
		lastStepIdx: -1,
		modelId: null,
		permissionMode: null,
		sandbox: false,
		cwd,
		additionalDirs,
		title: null,
		updatedAt: new Date().toISOString(),
	};
}
