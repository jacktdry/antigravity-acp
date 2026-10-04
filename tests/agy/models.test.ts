import { describe, expect, test } from "bun:test";
import {
	modelCatalog,
	modelSelection,
	selectModel,
} from "../../src/agy/models";

const models = [
	{ value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
	{ value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
	{ value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
	{ value: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
	{ value: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
	{ value: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
	{ value: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
	{ value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
	{ value: "claude-thinking", name: "Claude (Thinking)" },
];

describe("advertised model variants", () => {
	test("groups the actual AGY effort suffixes without stripping unrelated suffixes", () => {
		expect(modelCatalog(models).map((m) => [m.value, m.name])).toEqual([
			["gemini-3.8-flash", "Gemini 3.8 Flash"],
			["gemini-3.1-pro", "Gemini 3.1 Pro"],
			["claude-opus-5-5", "Claude Opus 5.5"],
			["gpt-oss-120b", "GPT-OSS 120B"],
			["claude-thinking", "Claude (Thinking)"],
		]);
	});
	test("restores legacy concrete modelId and its effort", () => {
		const selection = modelSelection(models, "gemini-3.8-flash-high");
		expect(selection.model?.value).toBe("gemini-3.8-flash");
		expect(selection.effort).toBe("high");
		expect(modelSelection(models, "retired-medium").concrete).toBe(
			"retired-medium",
		);
	});
	test("model switches retain effort only when advertised", () => {
		expect(selectModel(models, "gemini-3.8-flash-low", "gemini-3.1-pro")).toBe(
			"gemini-3.1-pro-high",
		);
		expect(selectModel(models, "gemini-3.1-pro-high", "claude-opus-5-5")).toBe(
			"claude-opus-5-5-high",
		);
		expect(selectModel(models, null, "gpt-oss-120b")).toBe(
			"gpt-oss-120b-medium",
		);
		expect(selectModel(models, null, "gemini-3.8-flash-high")).toBe(
			"gemini-3.8-flash-high",
		);
		expect(selectModel(models, null, "gemini-3.1-pro-low")).toBeUndefined();
	});
});
