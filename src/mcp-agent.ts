import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HevyClient, HevyApiError } from "./lib/client.js";
import {
	CreateWorkoutSchema,
	UpdateWorkoutSchema,
	CreateRoutineSchema,
	UpdateRoutineSchema,
	CreateExerciseTemplateSchema,
	CreateRoutineFolderSchema,
	transformWorkoutToAPI,
	transformRoutineToAPI,
	transformExerciseTemplateToAPI,
	transformRoutineFolderToAPI,
} from "./lib/schemas.js";
import {
	ValidationError,
	validatePagination,
	validateISO8601Date,
	validateWorkoutData,
	validateRoutineData,
	validateExerciseTemplate,
	PAGINATION_LIMITS,
} from "./lib/transforms.js";
import { handleError } from "./lib/errors.js";
import { TOOL_CATALOG } from "./lib/tool-catalog.js";
import type { Props } from "./utils.js";
import { getUserApiKey } from "./lib/key-storage.js";

// Environment interface for OAuth multi-user support
interface Env {
	MCP_OBJECT: DurableObjectNamespace;
	OAUTH_KV: KVNamespace;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	COOKIE_ENCRYPTION_KEY: string;
	// Legacy: HEVY_API_KEY is deprecated in favor of per-user keys in KV
	HEVY_API_KEY?: string;
}

// Define our MCP agent with Hevy API tools and OAuth support
export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Hevy API",
		version: "3.1.0",
		description: "Multi-user remote MCP server for Hevy fitness tracking API with OAuth authentication",
	});

	private client!: HevyClient;

	/**
	 * Resolve the Hevy API client, authenticating on first use.
	 *
	 * Deliberately NOT called from init(). Tool registration has to be
	 * unconditional: when the auth check and the KV read ran first and threw,
	 * the MCP server came up with an EMPTY tool list, so every call failed as
	 * "tool not found" rather than reporting an auth problem — and one transient
	 * KV miss on a cold Durable Object poisoned the entire session until it was
	 * evicted. Resolving lazily means an auth failure surfaces as an ordinary
	 * MCP tool error and the next call gets a fresh attempt.
	 */
	private async ensureClient(): Promise<HevyClient> {
		if (this.client) {
			return this.client;
		}

		if (!this.props || !this.props.login) {
			const setupHint = this.props?.baseUrl
				? ` Visit ${this.props.baseUrl}/setup to get started.`
				: " Visit your server URL to authenticate.";
			throw new Error(
				"Authentication required. Please authenticate via OAuth to use the Hevy MCP server." +
					setupHint
			);
		}

		// Load user's Hevy API key from encrypted KV storage
		const hevyApiKey = await getUserApiKey(
			this.env.OAUTH_KV,
			this.env.COOKIE_ENCRYPTION_KEY,
			this.props.login
		);

		if (!hevyApiKey) {
			const setupUrl = this.props.baseUrl
				? `${this.props.baseUrl}/setup`
				: '/setup (visit your server URL)';
			throw new Error(
				`Hevy API key not configured for user ${this.props.login}. ` +
					`Please visit ${setupUrl} to configure your API key.`
			);
		}

		this.client = new HevyClient({ apiKey: hevyApiKey });
		return this.client;
	}

	async init() {
		// Everything below is unconditional and synchronous — no awaits, no
		// throws, no branching. A cold start can therefore never bring the
		// server up with a partial or empty tool manifest.

		// ============================================
		// WORKOUTS
		// ============================================

		this.server.tool(
			"get_workouts",
			TOOL_CATALOG.get_workouts,
			{
				page: z.number().optional().default(1).describe("Page number (Must be 1 or greater)"),
				page_size: z.number().optional().default(10).describe("Number of items per page (Max 10)"),
			},
			async ({ page, page_size }) => {
				try {
					const client = await this.ensureClient();

					// Validate pagination parameters
					validatePagination(page, page_size, PAGINATION_LIMITS.WORKOUTS);

					const workouts = await client.getWorkouts({ page, pageSize: page_size });

					const workoutDetails = workouts.workouts?.map((workout: any, index: number) => {
						return `Workout ${index + 1}: ${workout.title || 'Untitled'}\n  ID: ${workout.id}\n  Date: ${workout.start_time}`;
					}).join('\n') || 'No workouts found';

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${workouts.workouts?.length || 0} workouts (page ${workouts.page} of ${workouts.page_count})`,
							},
							{
								type: "text",
								text: workoutDetails,
							},
							{
								type: "text",
								text: `\n\nFull data:\n${JSON.stringify(workouts.workouts, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_workout",
			TOOL_CATALOG.get_workout,
			{
				workout_id: z.string().describe("The ID of the workout to retrieve"),
			},
			async ({ workout_id }) => {
				try {
					const client = await this.ensureClient();

					const workout = await client.getWorkout(workout_id);

					return {
						content: [
							{
								type: "text",
								text: `Workout: ${workout.title || 'Untitled'}\nID: ${workout.id}\nExercises: ${workout.exercises?.length || 0}`,
							},
							{
								type: "text",
								text: JSON.stringify(workout, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"create_workout",
			TOOL_CATALOG.create_workout,
			CreateWorkoutSchema.shape,
			async (args) => {
				try {
					const client = await this.ensureClient();

					// Validate workout data including dates, exercises, and RPE values
					validateWorkoutData(args);

					const createWorkoutRes = await client.createWorkout(transformWorkoutToAPI(args));
					const rawWorkout = createWorkoutRes.workout ?? createWorkoutRes;
					const workout = Array.isArray(rawWorkout) ? rawWorkout[0] : rawWorkout;

					return {
						content: [
							{
								type: "text",
								text: `✓ Successfully logged workout: ${workout.title}`,
							},
							{
								type: "text",
								text: `Workout ID: ${workout.id}\nExercises: ${workout.exercises?.length || 0}\nStarted: ${args.start_time}`,
							},
							{
								type: "text",
								text: `\n\nWorkout data:\n${JSON.stringify(workout, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"update_workout",
			TOOL_CATALOG.update_workout,
			{
				workout_id: z.string().describe("The ID of the workout to update"),
				...UpdateWorkoutSchema.shape,
			},
			async (args) => {
				try {
					const client = await this.ensureClient();

					const { workout_id, ...workoutData } = args;

					// Validate workout data including dates, exercises, and RPE values
					validateWorkoutData(workoutData);

					const updateWorkoutRes = await client.updateWorkout(workout_id, transformWorkoutToAPI(workoutData));
					const rawWorkout = updateWorkoutRes.workout ?? updateWorkoutRes;
					const workout = Array.isArray(rawWorkout) ? rawWorkout[0] : rawWorkout;

					return {
						content: [
							{
								type: "text",
								text: `✓ Successfully updated workout: ${workout.title}`,
							},
							{
								type: "text",
								text: `Workout ID: ${workout.id}\nExercises: ${workout.exercises?.length || 0}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_workouts_count",
			TOOL_CATALOG.get_workouts_count,
			{},
			async () => {
				try {
					const client = await this.ensureClient();

					const result = await client.getWorkoutsCount();

					return {
						content: [
							{
								type: "text",
								text: `Total workouts: ${result.workout_count}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_workout_events",
			TOOL_CATALOG.get_workout_events,
			{
				since: z.string().describe("Get events since this date (ISO 8601 format, e.g., 2024-01-01T00:00:00Z). Required — use a past date to get all recent changes."),
				page: z.number().optional().default(1).describe("Page number (Must be 1 or greater)"),
				page_size: z.number().optional().default(10).describe("Number of items per page (Max 10)"),
			},
			async (args) => {
				try {
					const client = await this.ensureClient();

					// Validate pagination parameters
					validatePagination(args.page, args.page_size, PAGINATION_LIMITS.WORKOUT_EVENTS);

					// Validate since date format
					validateISO8601Date(args.since, "since");

					const params: any = { page: args.page, pageSize: args.page_size, since: args.since };

					const events = await client.getWorkoutEvents(params);

					const eventDetails = events.events?.map((event: any, index: number) => {
						if (event.type === 'deleted') {
							return `${index + 1}. DELETED - Workout ID: ${event.id}\n   Deleted at: ${event.deleted_at}`;
						} else {
							return `${index + 1}. UPDATED - ${event.workout?.title || 'Untitled'}\n   Workout ID: ${event.workout?.id}\n   Updated: ${event.workout?.updated_at}`;
						}
					}).join('\n') || 'No events found';

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${events.events?.length || 0} workout events (page ${events.page} of ${events.page_count})`,
							},
							{
								type: "text",
								text: eventDetails,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		// ============================================
		// ROUTINES
		// ============================================

		this.server.tool(
			"get_routines",
			TOOL_CATALOG.get_routines,
			{
				page: z.number().optional().default(1).describe("Page number (Must be 1 or greater)"),
				page_size: z.number().optional().default(5).describe("Number of items per page (Max 10)"),
			},
			async ({ page, page_size }) => {
				try {
					const client = await this.ensureClient();

					// Validate pagination parameters
					validatePagination(page, page_size, PAGINATION_LIMITS.ROUTINES);

					const routines = await client.getRoutines({ page, pageSize: page_size });

					const routineDetails = routines.routines?.map((routine: any, index: number) => {
						const exerciseCount = routine.exercises?.length || 0;
						return `Routine ${index + 1}: ${routine.title}\n  Exercises: ${exerciseCount}\n  ID: ${routine.id}`;
					}).join('\n') || 'No routines found';

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${routines.routines?.length || 0} routines (page ${routines.page} of ${routines.page_count})`,
							},
							{
								type: "text",
								text: routineDetails,
							},
							{
								type: "text",
								text: `\n\nFull data:\n${JSON.stringify(routines.routines, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_routine",
			TOOL_CATALOG.get_routine,
			{
				routine_id: z.string().describe("The ID of the routine to retrieve"),
			},
			async ({ routine_id }) => {
				try {
					const client = await this.ensureClient();

					const result = await client.getRoutine(routine_id);
					const routine = result.routine;

					return {
						content: [
							{
								type: "text",
								text: `Routine: ${routine.title}\nID: ${routine.id}\nExercises: ${routine.exercises?.length || 0}`,
							},
							{
								type: "text",
								text: JSON.stringify(routine, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"create_routine",
			TOOL_CATALOG.create_routine,
			CreateRoutineSchema.shape,
			async (args) => {
				try {
					const client = await this.ensureClient();

					// Validate routine data including exercises and sets
					validateRoutineData(args);

					const createRoutineRes = await client.createRoutine(transformRoutineToAPI(args));
					const rawRoutine = createRoutineRes.routine ?? createRoutineRes;
					const routine = Array.isArray(rawRoutine) ? rawRoutine[0] : rawRoutine;

					return {
						content: [
							{
								type: "text",
								text: `✓ Successfully created routine: ${routine.title}`,
							},
							{
								type: "text",
								text: `Routine ID: ${routine.id}\nExercises: ${routine.exercises?.length || 0}`,
							},
							{
								type: "text",
								text: `\n\nFull routine data:\n${JSON.stringify(routine, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"update_routine",
			TOOL_CATALOG.update_routine,
			{
				routine_id: z.string().describe("The ID of the routine to update"),
				...UpdateRoutineSchema.shape,
			},
			async (args) => {
				try {
					const client = await this.ensureClient();

					const { routine_id, ...routineData } = args;

					// Validate routine data including exercises and sets
					validateRoutineData(routineData);

					const updateRoutineRes = await client.updateRoutine(routine_id, transformRoutineToAPI(routineData));
					const rawRoutine = updateRoutineRes.routine ?? updateRoutineRes;
					const routine = Array.isArray(rawRoutine) ? rawRoutine[0] : rawRoutine;

					return {
						content: [
							{
								type: "text",
								text: `✓ Successfully updated routine: ${routine.title}`,
							},
							{
								type: "text",
								text: `Routine ID: ${routine.id}\nExercises: ${routine.exercises?.length || 0}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"delete_routine",
			TOOL_CATALOG.delete_routine,
			{
				routine_id: z.string().describe("The ID of the routine to delete"),
			},
			async ({ routine_id }) => {
				try {
					const client = await this.ensureClient();

					await client.deleteRoutine(routine_id);

					return {
						content: [
							{
								type: "text",
								text: `Routine ${routine_id} deleted successfully`,
							},
						],
					};
				} catch (error) {
					if (error instanceof HevyApiError && error.status === 404) {
						return {
							content: [{ type: "text", text: `❌ The Hevy public API does not support deleting routines.\n\nThis endpoint is not exposed in the Hevy API — routines can only be deleted inside the Hevy app itself.` }],
							isError: true,
						};
					}
					return handleError(error);
				}
			}
		);

		// ============================================
		// EXERCISE TEMPLATES
		// ============================================

		this.server.tool(
			"get_exercise_templates",
			TOOL_CATALOG.get_exercise_templates,
			{
				page: z.number().optional().default(1).describe("Page number (Must be 1 or greater)"),
				page_size: z.number().optional().default(20).describe("Number of items per page (Max 100)"),
			},
			async ({ page, page_size }) => {
				try {
					const client = await this.ensureClient();

					// Validate pagination parameters with higher limit for templates
					validatePagination(page, page_size, PAGINATION_LIMITS.EXERCISE_TEMPLATES);

					const templates = await client.getExerciseTemplates({ page, pageSize: page_size });

					const templateDetails = templates.exercise_templates?.map((template: any, index: number) => {
						return `${index + 1}. ${template.title} (${template.type})\n   ID: ${template.id}\n   Primary: ${template.primary_muscle_group}\n   Custom: ${template.is_custom ? 'Yes' : 'No'}`;
					}).join('\n') || 'No exercise templates found';

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${templates.exercise_templates?.length || 0} exercise templates (page ${templates.page} of ${templates.page_count})`,
							},
							{
								type: "text",
								text: templateDetails,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_exercise_template",
			TOOL_CATALOG.get_exercise_template,
			{
				exercise_template_id: z.string().describe("The ID of the exercise template"),
			},
			async ({ exercise_template_id }) => {
				try {
					const client = await this.ensureClient();

					const template = await client.getExerciseTemplate(exercise_template_id);

					return {
						content: [
							{
								type: "text",
								text: `Exercise: ${template.title}\nType: ${template.type}\nPrimary Muscle: ${template.primary_muscle_group}\nCustom: ${template.is_custom ? 'Yes' : 'No'}`,
							},
							{
								type: "text",
								text: JSON.stringify(template, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"create_exercise_template",
			TOOL_CATALOG.create_exercise_template,
			CreateExerciseTemplateSchema.shape,
			async (args) => {
				try {
					const client = await this.ensureClient();

					// Validate exercise template data
					validateExerciseTemplate(args);

					const result = await client.createExerciseTemplate(transformExerciseTemplateToAPI(args));

					return {
						content: [
							{
								type: "text",
								text: `✓ Successfully created custom exercise template: ${args.title}`,
							},
							{
								type: "text",
								text: `Exercise Template ID: ${result.id}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_exercise_history",
			TOOL_CATALOG.get_exercise_history,
			{
				exercise_template_id: z.string().describe("The ID of the exercise template"),
				start_date: z.string().optional().describe("Optional start date (ISO 8601 format, e.g., 2024-01-01T00:00:00Z)"),
				end_date: z.string().optional().describe("Optional end date (ISO 8601 format, e.g., 2024-12-31T23:59:59Z)"),
			},
			async (args) => {
				try {
					const client = await this.ensureClient();

					// Validate date formats if provided
					if (args.start_date) {
						validateISO8601Date(args.start_date, "start_date");
					}
					if (args.end_date) {
						validateISO8601Date(args.end_date, "end_date");
					}

					// Validate that end_date is after start_date if both are provided
					if (args.start_date && args.end_date) {
						const start = new Date(args.start_date);
						const end = new Date(args.end_date);
						if (end <= start) {
							throw new ValidationError("end_date must be after start_date");
						}
					}

					const params: any = {};
					if (args.start_date) params.start_date = args.start_date;
					if (args.end_date) params.end_date = args.end_date;

					const history = await client.getExerciseHistory(args.exercise_template_id, params);

					const historyDetails = history.exercise_history?.map((entry: any, index: number) => {
						return `${index + 1}. ${entry.workout_title} (${entry.workout_start_time})\n   Weight: ${entry.weight_kg}kg, Reps: ${entry.reps}, RPE: ${entry.rpe || 'N/A'}\n   Set Type: ${entry.set_type}`;
					}).join('\n') || 'No exercise history found';

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${history.exercise_history?.length || 0} exercise history entries`,
							},
							{
								type: "text",
								text: historyDetails,
							},
							{
								type: "text",
								text: `\n\nFull data:\n${JSON.stringify(history.exercise_history, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		// ============================================
		// ROUTINE FOLDERS
		// ============================================

		this.server.tool(
			"get_routine_folders",
			TOOL_CATALOG.get_routine_folders,
			{
				page: z.number().optional().default(1).describe("Page number (Must be 1 or greater)"),
				page_size: z.number().optional().default(10).describe("Number of items per page (Max 10)"),
			},
			async ({ page, page_size }) => {
				try {
					const client = await this.ensureClient();

					// Validate pagination parameters
					validatePagination(page, page_size, PAGINATION_LIMITS.ROUTINE_FOLDERS);

					const folders = await client.getRoutineFolders({ page, pageSize: page_size });

					const folderDetails = folders.routine_folders?.map((folder: any, index: number) => {
						return `${index + 1}. ${folder.title}\n   ID: ${folder.id}\n   Index: ${folder.index}`;
					}).join('\n') || 'No routine folders found';

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${folders.routine_folders?.length || 0} routine folders (page ${folders.page} of ${folders.page_count})`,
							},
							{
								type: "text",
								text: folderDetails,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_routine_folder",
			TOOL_CATALOG.get_routine_folder,
			{
				folder_id: z.string().describe("The ID of the routine folder"),
			},
			async ({ folder_id }) => {
				try {
					const client = await this.ensureClient();

					const folder = await client.getRoutineFolder(folder_id);

					return {
						content: [
							{
								type: "text",
								text: `Folder: ${folder.title}\nID: ${folder.id}\nIndex: ${folder.index}`,
							},
							{
								type: "text",
								text: JSON.stringify(folder, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"create_routine_folder",
			TOOL_CATALOG.create_routine_folder,
			CreateRoutineFolderSchema.shape,
			async (args) => {
				try {
					const client = await this.ensureClient();

					const createFolderRes = await client.createRoutineFolder(transformRoutineFolderToAPI(args));
					const rawFolder = createFolderRes.routine_folder ?? createFolderRes;
					const folder = Array.isArray(rawFolder) ? rawFolder[0] : rawFolder;

					return {
						content: [
							{
								type: "text",
								text: `✓ Successfully created routine folder: ${folder.title}`,
							},
							{
								type: "text",
								text: `Folder ID: ${folder.id}\nIndex: ${folder.index}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"delete_routine_folder",
			TOOL_CATALOG.delete_routine_folder,
			{
				folder_id: z.string().describe("The ID of the routine folder to delete. Routines inside are NOT deleted — they move to the default folder."),
			},
			async ({ folder_id }) => {
				try {
					const client = await this.ensureClient();

					await client.deleteRoutineFolder(folder_id);

					return {
						content: [
							{
								type: "text",
								text: `Folder ${folder_id} deleted successfully`,
							},
						],
					};
				} catch (error) {
					if (error instanceof HevyApiError && error.status === 404) {
						return {
							content: [{ type: "text", text: `❌ The Hevy public API does not support deleting routine folders.\n\nThis endpoint is not exposed in the Hevy API — folders can only be deleted inside the Hevy app itself.` }],
							isError: true,
						};
					}
					return handleError(error);
				}
			}
		);

		// ============================================
		// BODY MEASUREMENTS
		// ============================================

		this.server.tool(
			"get_body_measurements",
			TOOL_CATALOG.get_body_measurements,
			{
				page: z.number().optional().default(1).describe("Page number (Must be 1 or greater)"),
				page_size: z.number().optional().default(10).describe("Number of items per page (Max 10)"),
			},
			async ({ page, page_size }) => {
				try {
					const client = await this.ensureClient();

					validatePagination(page, page_size, PAGINATION_LIMITS.BODY_MEASUREMENTS);

					const result = await client.getBodyMeasurements({ page, pageSize: page_size });

					const measurements = result.body_measurements ?? result;
					const list = Array.isArray(measurements)
						? measurements.map((m: any, i: number) =>
							`${i + 1}. ${m.date}: ${m.weight_kg}kg${m.body_fat_percentage != null ? `, ${m.body_fat_percentage}% body fat` : ``}`)
						.join('\n')
						: 'No measurements found';

					return {
						content: [
							{
								type: "text",
								text: `Retrieved body measurements (page ${result.page ?? 1} of ${result.page_count ?? 1})`,
							},
							{
								type: "text",
								text: list,
							},
							{
								type: "text",
								text: `\n\nFull data:\n${JSON.stringify(result, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"create_body_measurement",
			TOOL_CATALOG.create_body_measurement,
			{
				date: z.string().describe("Date of the measurement (ISO 8601 format, e.g., 2026-05-25 or 2026-05-25T00:00:00Z)"),
				weight_kg: z.number().describe("Body weight in kilograms"),
				body_fat_percentage: z.number().optional().nullable().describe("Body fat percentage (optional)"),
			},
			async (args) => {
				try {
					const client = await this.ensureClient();

					validateISO8601Date(args.date, "date");

					const createRes = await client.createBodyMeasurement({
						date: args.date,
						weight_kg: args.weight_kg,
						...(args.body_fat_percentage != null ? { body_fat_percentage: args.body_fat_percentage } : {}),
					});
					const raw = createRes?.body_measurement ?? createRes;
					const measurement = Array.isArray(raw) ? raw[0] : raw;

					return {
						content: [
							{
								type: "text",
								text: `✓ Successfully logged body measurement`,
							},
							{
								type: "text",
								text: `Date: ${measurement.date ?? args.date}\nWeight: ${measurement.weight_kg ?? args.weight_kg}kg${measurement.body_fat_percentage != null ? `\nBody Fat: ${measurement.body_fat_percentage}%` : ``}`,
							},
							{
								type: "text",
								text: `\n\nFull response:\n${JSON.stringify(createRes, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);
	}
}
