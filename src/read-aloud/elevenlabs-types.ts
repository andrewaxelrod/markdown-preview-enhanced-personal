/* eslint-disable @typescript-eslint/naming-convention -- ElevenLabs wire format is snake_case (R2 §4.2, §9.1) */

/**
 * Wire-format types for the ElevenLabs REST API.
 *
 * These mirror the documented JSON shapes verbatim (R2 §4.2, §7.2, §7.3,
 * §8.3, §9.1, §10.1). This is the only module in `src/read-aloud/` that is
 * allowed to use snake_case identifiers; every other module converts at the
 * boundary.
 */

/** R2 §4.2 — `alignment` / `normalized_alignment`. */
export interface AlignmentWire {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** R2 §4.1 — the body we send to `/with-timestamps`. */
export interface WithTimestampsRequestWire {
  text: string;
  model_id: string;
  apply_text_normalization: 'auto';
  previous_text?: string;
  next_text?: string;
}

/** R2 §4.2 — the response of `/with-timestamps`. */
export interface WithTimestampsResponseWire {
  audio_base64: string;
  alignment?: AlignmentWire | null;
  normalized_alignment?: AlignmentWire | null;
}

/** R2 §9.1 — `detail` of an error body. */
export interface ErrorDetailWire {
  type?: string;
  code?: string;
  message?: string;
  status?: string;
  request_id?: string;
  param?: string;
}

/** R2 §9.1 — the error body itself. */
export interface ErrorBodyWire {
  detail?: ErrorDetailWire | string;
}

/** R2 §7.2 — one entry of `GET /v2/voices`. */
export interface VoiceWire {
  voice_id: string;
  name?: string;
  category?: string;
}

/** R2 §7.2 — one page of `GET /v2/voices`. */
export interface VoicesPageWire {
  voices: VoiceWire[];
  has_more: boolean;
  next_page_token?: string | null;
}

/** R2 §7.3 — `GET /v1/voices/{voice_id}`. */
export interface VoiceDetailWire {
  voice_id: string;
  name?: string;
  category?: string;
}

/** R2 §8.3 — one entry of `GET /v1/models`. */
export interface ModelWire {
  model_id: string;
  name?: string;
  can_do_text_to_speech?: boolean;
  max_characters_request_free_user?: number;
  max_characters_request_subscribed_user?: number;
  maximum_text_length_per_request?: number;
}

/** R2 §10.1 — `GET /v1/user/subscription`. */
export interface SubscriptionWire {
  tier: string;
  character_count: number;
  character_limit: number;
  status: string;
  next_character_count_reset_unix?: number;
}
