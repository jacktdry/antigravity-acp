import type { DiscoveredModel } from "./process";

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;

/** Only advertised low/medium/high suffix variants are split; other suffixes stay intact. */
export function modelCatalog(models: DiscoveredModel[]) {
	const bases = new Map<
		string,
		{
			value: string;
			name: string;
			variants: Map<string, string>;
		}
	>();
	for (const model of models) {
		const match = model.value.match(/^(.*)-(low|medium|high)$/);
		const base = match?.[1] ?? model.value;
		let entry = bases.get(base);
		if (!entry) {
			entry = {
				value: base,
				name: match
					? model.name.replace(/\s*\((?:Low|Medium|High)\)\s*$/i, "")
					: model.name,
				variants: new Map(),
			};
			bases.set(base, entry);
		}
		entry.variants.set(match?.[2] ?? "", model.value);
	}
	return [...bases.values()];
}

export function modelSelection(
	models: DiscoveredModel[],
	modelId: string | null,
) {
	const catalog = modelCatalog(models);
	const concrete = modelId ?? models[0]?.value;
	const model = catalog.find((m) =>
		[...m.variants.values()].includes(concrete ?? ""),
	);
	const effort = model
		? ([...model.variants].find(([, id]) => id === concrete)?.[0] ?? "")
		: "";
	return { catalog, model, effort, concrete };
}

/** Choose an exact advertised ID, never synthesize an unsupported variant. */
export function selectModel(
	models: DiscoveredModel[],
	current: string | null,
	value: string,
): string | undefined {
	const { catalog, effort } = modelSelection(models, current);
	const model = catalog.find((m) => m.value === value);
	if (!model) return models.find((m) => m.value === value)?.value;
	return (
		model.variants.get(effort) ??
		model.variants.get("medium") ??
		model.variants.values().next().value
	);
}
