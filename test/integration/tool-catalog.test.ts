import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOOL_CATALOG, TOOL_COUNT, TOOL_NAMES } from "../../src/lib/tool-catalog.js";

/**
 * Guards the two defects that made tools disappear from the manifest:
 *
 *  1. init() used to authenticate and read KV before registering anything, so a
 *     transient failure produced a server with ZERO tools and every call came
 *     back "tool not found". Registration must stay unconditional.
 *
 *  2. Tools were registered with no description, leaving a remote client only
 *     the bare name to rank on — which is why the two semantically shadowed
 *     tools (get_workout_events, get_exercise_history) kept losing discovery.
 *
 * Also pins the Zod chaining order that silently drops parameter descriptions.
 */

// Normalised to LF so the structural assertions below do not depend on the
// checkout's line endings.
const agentSource = readFileSync(
	fileURLToPath(new URL("../../src/mcp-agent.ts", import.meta.url)),
	"utf8",
).replace(/\r\n/g, "\n");

/** Body of init(), from the signature to the end of the file. */
const initBody = agentSource.slice(agentSource.indexOf("async init() {"));

/** Every name passed to this.server.tool(...), in registration order. */
const registeredNames = [...agentSource.matchAll(/this\.server\.tool\(\s*"([a-z_]+)"/g)].map(
	(m) => m[1],
);

describe("tool catalog / registration parity", () => {
	it("registers every tool the catalog declares", () => {
		expect([...registeredNames].sort()).toEqual([...TOOL_NAMES].sort());
	});

	it("registers no tool that is missing from the catalog", () => {
		const orphans = registeredNames.filter((n) => !(n in TOOL_CATALOG));
		expect(orphans).toEqual([]);
	});

	it("registers each tool exactly once", () => {
		expect(new Set(registeredNames).size).toBe(registeredNames.length);
	});

	it("keeps TOOL_COUNT in step with the catalog", () => {
		expect(TOOL_COUNT).toBe(registeredNames.length);
	});

	it("passes each tool its own catalog description", () => {
		for (const name of registeredNames) {
			expect(agentSource).toContain(`"${name}",\n\t\t\tTOOL_CATALOG.${name},`);
		}
	});
});

describe("tool descriptions", () => {
	it("gives every tool a description that is not just its name", () => {
		for (const [name, description] of Object.entries(TOOL_CATALOG)) {
			expect(description.trim()).not.toBe("");
			expect(description).not.toBe(name);
		}
	});

	it("gives every tool enough text for a client to rank on", () => {
		for (const [name, description] of Object.entries(TOOL_CATALOG)) {
			expect(
				description.length,
				`${name} description is too short to disambiguate`,
			).toBeGreaterThan(60);
		}
	});

	it("disambiguates the tools that lose discovery to their neighbours", () => {
		// These two are semantically shadowed by get_workouts and
		// get_exercise_templates. Their descriptions must point at the neighbour.
		expect(TOOL_CATALOG.get_workout_events).toContain("get_workouts");
		expect(TOOL_CATALOG.get_exercise_history).toContain("get_exercise_templates");
	});
});

describe("init() registration is unconditional", () => {
	const firstRegistration = initBody.indexOf("this.server.tool(");
	const preamble = initBody.slice(0, firstRegistration);

	it("has at least one registration to check", () => {
		expect(firstRegistration).toBeGreaterThan(-1);
	});

	it("does not await anything before registering tools", () => {
		// An await here means a slow or failing dependency can abort init()
		// partway and leave the manifest short.
		expect(preamble).not.toMatch(/\bawait\b/);
	});

	it("does not throw before registering tools", () => {
		// A throw here empties the manifest entirely: the server still starts,
		// but every tool call fails as "tool not found".
		expect(preamble).not.toMatch(/\bthrow\b/);
	});

	it("does not branch before registering tools", () => {
		expect(preamble).not.toMatch(/\bif\s*\(/);
	});

	it("resolves the API client lazily, inside handlers", () => {
		expect(agentSource).toContain("private async ensureClient()");
		const lazyCalls = agentSource.match(/await this\.ensureClient\(\)/g) ?? [];
		expect(lazyCalls.length).toBe(registeredNames.length);
	});
});

describe("zod chaining order", () => {
	it("never calls .describe() before .default()", () => {
		// .default() wraps the schema in a new ZodDefault whose own description is
		// empty, so a description written before it never reaches the emitted
		// JSON Schema and the client sees an undocumented parameter.
		const offenders = [...agentSource.matchAll(/\.describe\([^)]*\)\.default\(/g)];
		expect(offenders.map((m) => m[0])).toEqual([]);
	});
});
