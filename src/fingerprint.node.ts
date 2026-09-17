// Node-side audio fingerprint generation.
// Uses ffmpeg to decode any audio format to raw mono PCM, then runs
// the shared fingerprintPCM algorithm.

import { spawn } from 'child_process';
import { fingerprintPCM, TARGET_SAMPLE_RATE, AudioFingerprint } from './fingerprint';

export interface NodeDecodeOptions {
    /** ffmpeg binary to spawn. Defaults to `ffmpeg` on PATH; embedders that
     *  bundle their own binary (Electron + ffmpeg-static) pass it here. */
    ffmpegPath?: string;
}

/**
 * Decode an audio file to mono 32-bit float PCM using ffmpeg.
 * Works with mp3, m4a, wav, flac, ogg — anything ffmpeg supports.
 */
export function decodeToPCM(
    filePath: string,
    sampleRate = TARGET_SAMPLE_RATE,
    opts?: NodeDecodeOptions,
): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
        const chunks: Uint8Array[] = [];

        const proc = spawn(opts?.ffmpegPath || 'ffmpeg', [
            '-i', filePath,
            '-f', 'f32le',
            '-ac', '1',
            '-ar', String(sampleRate),
            'pipe:1',
        ]);

        proc.stdout.on('data', (chunk: Uint8Array) => chunks.push(chunk));
        proc.stderr.on('data', () => {}); // ffmpeg progress output
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`ffmpeg decode exited with code ${code}`));
                return;
            }
            const buf = Buffer.concat(chunks);
            resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
        });
    });
}

/**
 * Generate a fingerprint for an audio file on Node.
 * Decodes via ffmpeg then runs the shared fingerprint algorithm.
 */
export async function generateNodeFingerprint(
    filePath: string,
    opts?: NodeDecodeOptions,
): Promise<AudioFingerprint> {
    const samples = await decodeToPCM(filePath, TARGET_SAMPLE_RATE, opts);
    return fingerprintPCM(samples, TARGET_SAMPLE_RATE);
}
