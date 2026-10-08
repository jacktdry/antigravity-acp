import * as fs from "node:fs";
import * as path from "node:path";

const failure = () => new Error("Unsafe AGY_ACP_STATE_DIR or state file");

/** Opt-in only. Reject aliases rather than silently resolving symlink escapes. */
export function resolveStateDir(home: string, override?: string): string {
	if (override === undefined) return path.join(home, ".agy-acp");
	if (!override || override.includes("\0") || !path.isAbsolute(override))
		throw failure();
	const dir = path.resolve(override);
	if (dir === path.parse(dir).root) throw failure();
	validatePrivateState(dir, false);
	return dir;
}

export function validatePrivateState(dir: string, create = true): void {
	try {
		let current = path.parse(dir).root;
		for (const component of dir.slice(current.length).split(path.sep)) {
			current = path.join(current, component);
			if (!fs.existsSync(current)) {
				// lstat catches dangling symlinks too.
				try {
					fs.lstatSync(current);
					throw failure();
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				if (!create) continue;
				fs.mkdirSync(current, { mode: 0o700 });
			}
			const stat = fs.lstatSync(current, { throwIfNoEntry: false });
			if (!stat) continue;
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
			if (stat.uid !== 0 && stat.uid !== process.getuid?.()) throw failure();
			// Permit OS-owned sticky temp parents, never a shared leaf.
			const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
			if ((stat.mode & 0o022) !== 0 && !stickyRoot) throw failure();
			if (
				current === dir &&
				(stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
			)
				throw failure();
		}
	} catch {
		throw failure();
	}
}

function validateFile(stat: fs.Stats): void {
	if (
		!stat.isFile() ||
		stat.nlink !== 1 ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o077) !== 0
	)
		throw failure();
}

export function readPrivateState(file: string): string | null {
	validatePrivateState(path.dirname(file));
	let fd: number;
	try {
		const existing = fs.lstatSync(file, { throwIfNoEntry: false });
		if (!existing) return null;
		validateFile(existing);
		fd = fs.openSync(
			file,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw failure();
	}
	try {
		validateFile(fs.fstatSync(fd));
		return fs.readFileSync(fd, "utf8");
	} finally {
		fs.closeSync(fd);
	}
}

export function writePrivateState(file: string, contents: string): void {
	validatePrivateState(path.dirname(file));
	const existing = fs.lstatSync(file, { throwIfNoEntry: false });
	if (existing) validateFile(existing);
	const tmp = `${file}.${crypto.randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tmp, contents, { flag: "wx", mode: 0o600 });
		validatePrivateState(path.dirname(file), false);
		fs.renameSync(tmp, file);
	} catch {
		throw failure();
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}
