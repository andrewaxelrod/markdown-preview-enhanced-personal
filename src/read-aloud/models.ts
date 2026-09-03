import type { ModelWire } from './elevenlabs-types';

/**
 * Per-model character limits (F11, R2 §8.1, §8.3).
 *
 * Pure module: no `vscode`, no I/O. The limits are read once per session from
 * `GET /v1/models`; until then (and if the call fails) the R2 §8.1 table
 * applies.
 */

/**
 * Flash v2.5: half the per-character cost of Multilingual v2 and the lowest
 * latency, at the price of number/date normalization on non-Enterprise plans
 * (R2 §8.2). Multilingual v2 stays one setting away for documents that need
 * it.
 */
export const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';

/** The three ids offered by the `elevenLabsModelId` setting (spec F9). */
export const MODEL_IDS = [
  'eleven_multilingual_v2',
  'eleven_flash_v2_5',
  'eleven_v3',
] as const;

/* eslint-disable @typescript-eslint/naming-convention -- the keys are ElevenLabs model ids (R2 §8.1) */
/** R2 §8.1 "character limits" table, verbatim. */
export const FALLBACK_LIMITS: Readonly<Record<string, number>> = {
  eleven_v3: 5000,
  eleven_flash_v2_5: 40000,
  eleven_flash_v2: 30000,
  eleven_multilingual_v2: 10000,
};
/* eslint-enable @typescript-eslint/naming-convention */

/** Smallest documented limit, used for a model id we have never heard of. */
export const FALLBACK_LIMIT_UNKNOWN_MODEL = 5000;

export interface ModelLimits {
  modelId: string;
  maxChars: number;
  source: 'api' | 'fallback';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Free plans get the smaller `max_characters_request_free_user` limit
 * (R2 §8.3). When the subscription could not be read at all we assume "free",
 * because that is the smaller limit and therefore the safe guess.
 */
export function isFreeSubscription(
  status: string | undefined,
  tier: string | undefined,
): boolean {
  if (status === undefined && tier === undefined) {
    return true;
  }
  if (status === 'free' || status === 'free_disabled') {
    return true;
  }
  if (typeof tier === 'string' && tier.toLowerCase() === 'free') {
    return true;
  }
  return false;
}

/**
 * `min(free|subscribed limit, maximum_text_length_per_request)` (R2 §8.3).
 * Falls back to the R2 §8.1 table when the model row is missing or carries no
 * usable number.
 */
export function limitFromModel(
  model: ModelWire | undefined,
  isFree: boolean,
  modelId: string,
): ModelLimits {
  const fallback: ModelLimits = {
    modelId,
    maxChars: FALLBACK_LIMITS[modelId] ?? FALLBACK_LIMIT_UNKNOWN_MODEL,
    source: 'fallback',
  };
  if (!model) {
    return fallback;
  }
  const free = model.max_characters_request_free_user;
  const subscribed = model.max_characters_request_subscribed_user;
  const perRequest = model.maximum_text_length_per_request;
  const preferred = isFree ? (free ?? subscribed) : (subscribed ?? free);
  const candidates: number[] = [];
  if (isPositiveInteger(preferred)) {
    candidates.push(preferred);
  }
  if (isPositiveInteger(perRequest)) {
    candidates.push(perRequest);
  }
  if (candidates.length === 0) {
    return fallback;
  }
  return { modelId, maxChars: Math.min(...candidates), source: 'api' };
}

/** The `/v1/models` row for `modelId`, or `undefined`. */
export function findModel(
  models: ModelWire[],
  modelId: string,
): ModelWire | undefined {
  return models.find((model) => model.model_id === modelId);
}
