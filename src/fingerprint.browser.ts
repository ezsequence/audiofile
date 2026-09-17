// Browser-side audio fingerprint generation.
// Uses the Web Audio API to decode any format the browser supports
// (mp3, m4a, wav, ogg, flac, …) to PCM, then runs the shared algorithm.

import { fingerprintPCM, TARGET_SAMPLE_RATE, AudioFingerprint } from './fingerprint';

/**
 * Generate a fingerprint from a browser File (e.g. from <input type="file">).
 *
 * Decodes the file via AudioContext, resamples to the target rate,
 * mixes to mono, then runs the shared fingerprint algorithm so the
 * result is comparable to a server-side Node fingerprint of the same audio.
 */
export async function generateBrowserFingerprint(
    file: File,
): Promise<AudioFingerprint> {
    const arrayBuffer = await file.arrayBuffer();

    // Decode with a temporary AudioContext
    const audioCtx = new AudioContext();
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    await audioCtx.close();

    // Resample to TARGET_SAMPLE_RATE mono via OfflineAudioContext
    const targetLength = Math.round(decoded.duration * TARGET_SAMPLE_RATE);
    const offlineCtx = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
    const source = offlineCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineCtx.destination);
    source.start();

    const rendered = await offlineCtx.startRendering();
    const mono = rendered.getChannelData(0);

    return fingerprintPCM(mono, TARGET_SAMPLE_RATE);
}
