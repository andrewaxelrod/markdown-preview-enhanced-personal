/* eslint-disable @typescript-eslint/naming-convention -- Kokoro-FastAPI wire format is snake_case */

/**
 * Wire-format types for the Kokoro-FastAPI server
 * (<https://github.com/remsky/Kokoro-FastAPI>), the local OpenAI-compatible
 * wrapper around the Apache-licensed Kokoro-82M model.
 *
 * Mirrors `api/src/structures/schemas.py` of the server verbatim. Like
 * `elevenlabs-types.ts`, this is the only Kokoro module allowed to use
 * snake_case identifiers; every other module converts at the boundary.
 */

/** `POST /dev/captioned_speech` body (the non-streaming, timestamped call). */
export interface CaptionedSpeechRequestWire {
  model: 'kokoro';
  input: string;
  voice: string;
  speed: number;
  response_format: 'mp3';
  stream: false;
  return_timestamps: true;
  normalization_options: {
    /**
     * `false`: the server's own text normaliser rewrites "$12.50" as "twelve
     * dollars and fifty cents" *before* the G2P step, so the words in its
     * timestamps no longer match the text the webview built its offset map
     * from. Kokoro's misaki G2P handles numbers, dates and currency itself.
     */
    normalize: boolean;
  };
}

/** One entry of `timestamps` in the response. */
export interface WordTimestampWire {
  word: string;
  start_time: number;
  end_time: number;
  voice?: string | null;
}

/** `POST /dev/captioned_speech` response. */
export interface CaptionedSpeechResponseWire {
  audio: string;
  audio_format?: string;
  timestamps?: WordTimestampWire[] | null;
}

/** One entry of `GET /v1/audio/voices`. */
export interface KokoroVoiceWire {
  id: string;
  name?: string;
  target_quality?: string | null;
  training_duration?: string | null;
  overall_grade?: string | null;
}

/** `GET /v1/audio/voices`. */
export interface KokoroVoicesWire {
  voices: KokoroVoiceWire[];
}

/** `GET /health`. */
export interface KokoroHealthWire {
  status?: string;
}

/** `detail` of an error body. */
export interface KokoroErrorDetailWire {
  error?: string;
  message?: string;
  type?: string;
}

/** The error body itself. */
export interface KokoroErrorBodyWire {
  detail?: KokoroErrorDetailWire | string;
}
