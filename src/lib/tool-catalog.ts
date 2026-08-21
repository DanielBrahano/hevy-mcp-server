/**
 * Single source of truth for tool names and descriptions.
 *
 * Both `MyMCP.init()` (which registers the tools inside the Durable Object) and
 * the `/health` route (which runs in the Worker and cannot see the DO's registry)
 * read from this object, so the health endpoint can never drift from what is
 * actually registered.
 *
 * Registering a tool whose name is not a key here is a compile-time error,
 * because `init()` passes `TOOL_CATALOG.<name>` as the description argument.
 * A runtime parity test asserts the reverse direction.
 *
 * Descriptions matter more than they look: a remote MCP client ranks and filters
 * tools primarily on this text. Tools whose names are semantically shadowed by a
 * neighbour (get_workout_events vs get_workouts, get_exercise_history vs
 * get_exercise_templates) explicitly say what they are NOT, so they stop losing
 * that ranking contest.
 */
export const TOOL_CATALOG = {
	// ============================================
	// WORKOUTS — sessions the user actually performed
	// ============================================
	get_workouts:
		"List recently logged workouts, newest first, with title, ID and date. Use for 'what did I train this week', 'show my last few sessions', or any question about training the user has actually done. Returns a paginated summary plus the full workout JSON including every exercise and set. For a feed of edits and deletions rather than the sessions themselves, use get_workout_events.",

	get_workout:
		"Fetch one complete logged workout by its UUID, including every exercise, set, weight, reps, RPE and note. Use after get_workouts when the full detail of one specific session is needed.",

	create_workout:
		"Log a new completed workout to Hevy — a training session that already happened, with its exercises, sets, weights and reps. Use when the user says they finished a session and wants it recorded. Requires start_time and end_time; returns the created workout with its new ID.",

	update_workout:
		"Overwrite an existing logged workout by ID — correct the weights, reps, sets, title or notes of a session already in Hevy. This is a full replacement, so include every exercise that should survive the edit.",

	get_workouts_count:
		"Return the total number of workouts ever logged to this account as a single number. Use for lifetime totals, training frequency and consistency questions without paging through the whole history.",

	get_workout_events:
		"Return the change feed of workouts created, updated or deleted since a given timestamp — a sync/audit log, NOT the workouts themselves. Each entry is an 'updated' or 'deleted' event carrying a workout ID and a timestamp. Use to find what changed since a previous sync, to spot recently edited sessions, or to discover that a workout was deleted. Requires `since`. To list the training sessions themselves, use get_workouts.",

	// ============================================
	// ROUTINES — reusable templates the user plans to follow
	// ============================================
	get_routines:
		"List saved workout routines — the reusable training templates the user follows — with title, ID, folder and exercises. Use for 'what programs do I have', 'show my push day', 'what's in my current split'. Routines are plans; get_workouts returns sessions actually performed.",

	get_routine:
		"Fetch one routine template by ID with its full exercise and set structure, including rest times and target rep ranges.",

	create_routine:
		"Create a new reusable workout routine (a training template) with its exercises, target sets and rep ranges. Use when building a program or adding a new training day. Pass folder_id to file it under an existing routine folder.",

	update_routine:
		"Overwrite an existing routine by ID — change its exercises, sets, rep ranges, notes or folder. This is a full replacement, so include every exercise that should survive the edit.",

	delete_routine:
		"Attempt to delete a routine by ID. The Hevy public API exposes no delete endpoint for routines, so this reports that deletion has to be done inside the Hevy app. Registered so the limitation is explained clearly instead of surfacing as an unexplained 404.",

	// ============================================
	// EXERCISES — catalog of movements vs the user's own performance
	// ============================================
	get_exercise_templates:
		"Browse Hevy's catalog of available exercise types — the master list of movements such as 'Bench Press (Barbell)' — returning each one's template ID, muscle group, equipment and type. Use to look up the exercise_template_id that create_workout and create_routine require. This is the catalog of movements that exist, not the user's performance data.",

	get_exercise_template:
		"Fetch one exercise type from the Hevy catalog by its template ID, with title, muscle group, equipment and exercise type.",

	create_exercise_template:
		"Create a custom exercise in this Hevy account for a movement missing from the standard catalog. Returns the new template ID for use in workouts and routines.",

	get_exercise_history:
		"Return the user's own past performance for a single exercise over time — every set, weight and rep logged for that movement, optionally limited to a date range. Use for progression and progressive-overload questions: 'how has my bench press progressed', 'what is my best squat', 'am I getting stronger on deadlift', 'what did I lift for rows last time'. Requires an exercise_template_id from get_exercise_templates. This returns the user's training history for one movement; get_exercise_templates returns the catalog of movements.",

	// ============================================
	// ROUTINE FOLDERS
	// ============================================
	get_routine_folders:
		"List the folders that organise routines, with each folder's ID, title and index. Use to see how a program is structured, or to get a folder_id to pass to create_routine.",

	get_routine_folder:
		"Fetch a single routine folder by ID, with its title and index.",

	create_routine_folder:
		"Create a new folder for organising routines. Returns the new folder ID for use as folder_id in create_routine.",

	delete_routine_folder:
		"Attempt to delete a routine folder by ID. The Hevy public API exposes no delete endpoint for folders, so this reports that deletion has to be done inside the Hevy app. Registered so the limitation is explained clearly instead of surfacing as an unexplained 404.",

	// ============================================
	// BODY MEASUREMENTS
	// ============================================
	get_body_measurements:
		"Return logged bodyweight and body-composition history — date, weight in kg, and body-fat percentage or lean mass where recorded. Use for weight-trend questions: 'how has my weight changed', 'what did I weigh last week', 'am I cutting or bulking'.",

	create_body_measurement:
		"Log a bodyweight entry, and optionally a body-fat percentage, for a given date. Use when the user reports weighing themselves. Hevy permits only one measurement per date — logging a date that already has an entry returns a conflict rather than overwriting.",
} as const;

/** Every registered tool name, derived from the catalog. */
export type ToolName = keyof typeof TOOL_CATALOG;

/** Tool names in registration order. */
export const TOOL_NAMES = Object.keys(TOOL_CATALOG) as ToolName[];

/** Number of tools the server registers. */
export const TOOL_COUNT = TOOL_NAMES.length;
