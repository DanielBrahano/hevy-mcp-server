/**
 * Configuration options for the Hevy API client
 */
export interface HevyClientConfig {
  /**
   * API key for authenticating with the Hevy API
   */
  apiKey: string;

  /**
   * Base URL for the Hevy API (defaults to the production API)
   */
  baseUrl?: string;
}

/**
 * Error class for Hevy API errors
 */
export class HevyApiError extends Error {
  status: number;
  data?: any;

  constructor(message: string, status: number, data?: any) {
    super(message);
    this.name = 'HevyApiError';
    this.status = status;
    this.data = data;
  }
}

/** Abort an upstream call that has not responded within this many ms. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Retry attempts after the initial try, for transient failures only. */
export const MAX_RETRIES = 3;

/** Base for exponential backoff: 300ms, 600ms, 1200ms (plus jitter). */
const BASE_BACKOFF_MS = 300;

/** Never wait longer than this between attempts, whatever Retry-After says. */
const MAX_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide whether a failed response is worth retrying.
 *
 * 429 is always safe to retry: a rate-limited request was rejected before it
 * was processed, so no write happened. 5xx is only safe on idempotent methods —
 * retrying a POST that returned 500 could duplicate a workout that was in fact
 * created, so writes fail fast and let the caller decide.
 */
function isRetryable(status: number, idempotent: boolean): boolean {
  if (status === 429) return true;
  if (!idempotent) return false;
  return status === 500 || status === 502 || status === 503 || status === 504;
}

/** Honour Retry-After (seconds or HTTP date) when present, else exponential backoff with jitter. */
function retryDelayMs(response: Response | null, attempt: number): number {
  const header = response?.headers.get('Retry-After');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
      return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS);
    }
  }
  const backoff = BASE_BACKOFF_MS * 2 ** attempt;
  const jitter = Math.random() * BASE_BACKOFF_MS;
  return Math.min(backoff + jitter, MAX_BACKOFF_MS);
}

/**
 * Client for interacting with the Hevy API
 */
export class HevyClient {
  private apiKey: string;
  private baseUrl: string;

  /**
   * Create a new Hevy API client
   */
  constructor(config: HevyClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.hevyapp.com';
  }

  /**
   * Execute a request to the Hevy API.
   *
   * Every call is bounded by REQUEST_TIMEOUT_MS — without it a hung upstream
   * would hold the Worker request open until the platform killed it, which the
   * caller sees as an unexplained dead tool rather than an error. Transient
   * failures (429 always, 5xx and network errors on idempotent methods) are
   * retried with exponential backoff; everything else fails fast as a
   * HevyApiError so handleError can render it as a proper MCP error.
   */
  private async request<T>(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      queryParams?: Record<string, string | number | boolean | undefined>;
    }
  ): Promise<T> {
    const { method, body, queryParams } = options;

    // Construct query string if query parameters are provided
    const queryString = queryParams
      ? '?' + new URLSearchParams(
          Object.entries(queryParams)
            .filter(([_, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)])
        ).toString()
      : '';

    // Construct the full URL
    const url = `${this.baseUrl}${path}${queryString}`;

    // Set up request headers
    const headers = new Headers({
      'api-key': this.apiKey,
      'Content-Type': 'application/json',
    });

    // Only GET is safe to replay — see isRetryable().
    const idempotent = method === 'GET';
    const serializedBody = body ? JSON.stringify(body) : undefined;

    for (let attempt = 0; ; attempt++) {
      let response: Response;

      try {
        response = await fetch(url, {
          method,
          headers,
          body: serializedBody,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        // Timeout or network-level failure — no response was received, so a
        // replay is safe for idempotent methods.
        const timedOut = error instanceof Error && error.name === 'TimeoutError';

        if (idempotent && attempt < MAX_RETRIES) {
          await sleep(retryDelayMs(null, attempt));
          continue;
        }

        throw new HevyApiError(
          timedOut
            ? `Hevy API request timed out after ${REQUEST_TIMEOUT_MS}ms`
            : `Could not reach the Hevy API: ${error instanceof Error ? error.message : 'network error'}`,
          504,
          { url: path, method, attempts: attempt + 1 }
        );
      }

      if (attempt < MAX_RETRIES && isRetryable(response.status, idempotent)) {
        await sleep(retryDelayMs(response, attempt));
        continue;
      }

      // 204 No Content — no body to parse, treat as success
      if (response.status === 204) {
        return undefined as unknown as T;
      }

      // Parse the response
      const data = response.headers.get('Content-Type')?.includes('application/json')
        ? await response.json()
        : await response.text();

      // Handle error responses
      if (!response.ok) {
        throw new HevyApiError(
          `Hevy API request failed: ${response.status} ${response.statusText}`,
          response.status,
          data
        );
      }

      return data as T;
    }
  }

  /**
   * Helper method for GET requests
   */
  private async get<T>(
    path: string,
    queryParams?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    return this.request<T>(path, { method: 'GET', queryParams });
  }

  /**
   * Helper method for POST requests
   */
  private async post<T>(
    path: string,
    body?: unknown,
    queryParams?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    return this.request<T>(path, { method: 'POST', body, queryParams });
  }

  /**
   * Helper method for PUT requests
   */
  private async put<T>(
    path: string,
    body?: unknown,
    queryParams?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body, queryParams });
  }

  /**
   * Helper method for DELETE requests
   */
  private async delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  // ============================================
  // WORKOUTS
  // ============================================

  /**
   * Get a paginated list of workouts
   */
  async getWorkouts(options?: { page?: number; pageSize?: number }): Promise<any> {
    return this.get<any>('/v1/workouts', options as Record<string, string | number | boolean | undefined>);
  }

  /**
   * Get a single workout by ID
   */
  async getWorkout(workoutId: string): Promise<any> {
    return this.get<any>(`/v1/workouts/${workoutId}`);
  }

  /**
   * Create a new workout
   */
  async createWorkout(workout: any): Promise<any> {
    return this.post<any>('/v1/workouts', workout);
  }

  /**
   * Update an existing workout
   */
  async updateWorkout(workoutId: string, workout: any): Promise<any> {
    return this.put<any>(`/v1/workouts/${workoutId}`, workout);
  }

  /**
   * Get the total count of workouts
   */
  async getWorkoutsCount(): Promise<{ workout_count: number }> {
    return this.get<{ workout_count: number }>('/v1/workouts/count');
  }

  /**
   * Get workout events (updates or deletes) since a given date
   */
  async getWorkoutEvents(options?: { page?: number; pageSize?: number; since?: string }): Promise<any> {
    return this.get<any>('/v1/workouts/events', options as Record<string, string | number | boolean | undefined>);
  }

  // ============================================
  // ROUTINES
  // ============================================

  /**
   * Get a paginated list of routines
   */
  async getRoutines(options?: { page?: number; pageSize?: number }): Promise<any> {
    return this.get<any>('/v1/routines', options as Record<string, string | number | boolean | undefined>);
  }

  /**
   * Get a single routine by ID
   */
  async getRoutine(routineId: string): Promise<{ routine: any }> {
    return this.get<{ routine: any }>(`/v1/routines/${routineId}`);
  }

  /**
   * Create a new routine
   */
  async createRoutine(routine: any): Promise<any> {
    return this.post<any>('/v1/routines', routine);
  }

  /**
   * Update an existing routine
   */
  async updateRoutine(routineId: string, routine: any): Promise<any> {
    return this.put<any>(`/v1/routines/${routineId}`, routine);
  }

  // ============================================
  // EXERCISE TEMPLATES
  // ============================================

  /**
   * Get a paginated list of exercise templates
   */
  async getExerciseTemplates(options?: { page?: number; pageSize?: number }): Promise<any> {
    return this.get<any>('/v1/exercise_templates', options as Record<string, string | number | boolean | undefined>);
  }

  /**
   * Get a single exercise template by ID
   */
  async getExerciseTemplate(exerciseTemplateId: string): Promise<any> {
    return this.get<any>(`/v1/exercise_templates/${exerciseTemplateId}`);
  }

  /**
   * Get exercise history for a specific exercise template
   */
  async getExerciseHistory(
    exerciseTemplateId: string,
    params?: { start_date?: string; end_date?: string }
  ): Promise<any> {
    return this.get<any>(
      `/v1/exercise_history/${exerciseTemplateId}`,
      params as Record<string, string | number | boolean | undefined>
    );
  }

  // ============================================
  // ROUTINE FOLDERS
  // ============================================

  /**
   * Get a paginated list of routine folders
   */
  async getRoutineFolders(options?: { page?: number; pageSize?: number }): Promise<any> {
    return this.get<any>('/v1/routine_folders', options as Record<string, string | number | boolean | undefined>);
  }

  /**
   * Get a single routine folder by ID
   */
  async getRoutineFolder(folderId: string): Promise<any> {
    return this.get<any>(`/v1/routine_folders/${folderId}`);
  }

  /**
   * Create a new routine folder
   */
  async createRoutineFolder(folder: any): Promise<any> {
    return this.post<any>('/v1/routine_folders', folder);
  }

  /**
   * Delete a routine by ID
   */
  async deleteRoutine(routineId: string): Promise<any> {
    return this.delete<any>(`/v1/routines/${routineId}`);
  }

  /**
   * Delete a routine folder by ID
   */
  async deleteRoutineFolder(folderId: string): Promise<any> {
    return this.delete<any>(`/v1/routine_folders/${folderId}`);
  }

  /**
   * Create a new custom exercise template
   */
  async createExerciseTemplate(exercise: any): Promise<any> {
    return this.post<any>('/v1/exercise_templates', exercise);
  }

  // ============================================
  // BODY MEASUREMENTS
  // ============================================

  /**
   * Get body measurements (bodyweight, body fat %)
   */
  async getBodyMeasurements(options?: { page?: number; pageSize?: number }): Promise<any> {
    return this.get<any>('/v1/body_measurements', options as Record<string, string | number | boolean | undefined>);
  }

  /**
   * Create a body measurement entry
   */
  async createBodyMeasurement(data: { date: string; weight_kg: number; body_fat_percentage?: number | null }): Promise<any> {
    return this.post<any>('/v1/body_measurements', data);
  }
}
