// Audio fingerprinting — core algorithm.
// Platform-agnostic: operates on raw mono PCM samples (Float32Array).
//
// Uses the Haitsma-Kalker sub-fingerprint method:
//   - Divide the spectrum into logarithmic frequency bands
//   - For each pair of consecutive frames and consecutive bands,
//     record a bit based on relative energy change
//   - This is inherently amplitude-invariant: only relative energy
//     differences matter, not absolute levels
//
// The result survives loudness normalization, moderate dynamic compression,
// and re-encoding (e.g. original mp3 → normalize → re-encode mp3).

const FFT_SIZE = 2048;
const HOP_SIZE = 1024; // 50% overlap
const BAND_COUNT = 33; // 33 bands → 32 bits per sub-fingerprint

export const TARGET_SAMPLE_RATE = 44100;

export interface AudioFingerprint {
    /** Compact hex hash for quick equality check (from coarse sub-fingerprints). */
    hash: string;
    /** Per-frame sub-fingerprints for fine-grained similarity scoring. */
    subprints: Uint32Array;
    /** Audio duration in seconds. */
    duration: number;
}

/**
 * Compute a fingerprint from mono PCM audio data.
 *
 * For consistent results across platforms, callers should decode to mono
 * at TARGET_SAMPLE_RATE (44100 Hz) before calling this function.
 */
export function fingerprintPCM(mono: Float32Array, sampleRate: number): AudioFingerprint {
    const duration = mono.length / sampleRate;

    const numFrames = Math.floor((mono.length - FFT_SIZE) / HOP_SIZE) + 1;
    if (numFrames < 2) {
        return { hash: '0', subprints: new Uint32Array(0), duration };
    }

    const window = hanningWindow(FFT_SIZE);
    const bandBins = computeBandBins(sampleRate);

    // Compute band energies for every frame
    const bandEnergies: Float64Array[] = new Array(numFrames);
    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);

    for (let frame = 0; frame < numFrames; frame++) {
        const offset = frame * HOP_SIZE;

        // Apply Hanning window
        for (let i = 0; i < FFT_SIZE; i++) {
            re[i] = (offset + i < mono.length ? mono[offset + i] : 0) * window[i];
            im[i] = 0;
        }

        fftInPlace(re, im);

        // Sum magnitude² in each band
        const energies = new Float64Array(BAND_COUNT);
        for (let b = 0; b < BAND_COUNT; b++) {
            const lo = bandBins[b];
            const hi = bandBins[b + 1];
            let e = 0;
            for (let k = lo; k < hi; k++) {
                e += re[k] * re[k] + im[k] * im[k];
            }
            energies[b] = e;
        }
        bandEnergies[frame] = energies;
    }

    // Haitsma-Kalker: for each consecutive-frame pair, compare
    // energy differences across consecutive bands → 32 bits
    const numSubprints = numFrames - 1;
    const subprints = new Uint32Array(numSubprints);

    for (let t = 0; t < numSubprints; t++) {
        let bits = 0;
        for (let b = 0; b < BAND_COUNT - 1; b++) {
            const diff =
                (bandEnergies[t][b] - bandEnergies[t][b + 1]) -
                (bandEnergies[t + 1][b] - bandEnergies[t + 1][b + 1]);
            if (diff > 0) {
                bits |= 1 << b;
            }
        }
        subprints[t] = bits >>> 0;
    }

    // Compact hash: sample ~1 sub-fingerprint per second, hash with djb2
    const framesPerSec = Math.max(1, Math.round(sampleRate / HOP_SIZE));
    let hash = 5381;
    for (let i = 0; i < numSubprints; i += framesPerSec) {
        const v = subprints[i];
        hash = ((hash * 33) ^ (v & 0xffff)) >>> 0;
        hash = ((hash * 33) ^ (v >>> 16)) >>> 0;
    }

    return { hash: hash.toString(16), subprints, duration };
}

/**
 * Compare two fingerprints. Returns a similarity score from 0 to 1.
 * Based on fraction of matching bits across aligned sub-fingerprints.
 * A score above ~0.7 typically indicates the same recording.
 */
export function fingerprintSimilarity(
    a: AudioFingerprint,
    b: AudioFingerprint,
): number {
    const len = Math.min(a.subprints.length, b.subprints.length);
    if (len === 0) return 0;

    let matchingBits = 0;
    for (let i = 0; i < len; i++) {
        matchingBits += 32 - popcount32((a.subprints[i] ^ b.subprints[i]) >>> 0);
    }
    return matchingBits / (len * 32);
}

/**
 * Stable hash (djb2). Returns an unsigned 32-bit hex string.
 */
export function hashString(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash * 33) ^ str.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
}

// ── internals ──────────────────────────────────────────────────────

function hanningWindow(n: number): Float64Array {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    return w;
}

/** Log-spaced band edges from 200 Hz to 8000 Hz, mapped to FFT bins. */
function computeBandBins(sampleRate: number): Int32Array {
    const minFreq = 200;
    const maxFreq = Math.min(8000, sampleRate / 2);
    const ratio = Math.pow(maxFreq / minFreq, 1 / BAND_COUNT);
    const bins = new Int32Array(BAND_COUNT + 1);
    for (let i = 0; i <= BAND_COUNT; i++) {
        const freq = minFreq * Math.pow(ratio, i);
        bins[i] = Math.round((freq * FFT_SIZE) / sampleRate);
    }
    // Ensure each band covers at least 1 bin and is monotonically increasing
    for (let i = 1; i <= BAND_COUNT; i++) {
        if (bins[i] <= bins[i - 1]) bins[i] = bins[i - 1] + 1;
    }
    return bins;
}

/** In-place radix-2 Cooley-Tukey FFT. */
function fftInPlace(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
            tmp = im[i]; im[i] = im[j]; im[j] = tmp;
        }
    }
    // Butterfly stages
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        const wRe = Math.cos(ang);
        const wIm = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let curRe = 1,
                curIm = 0;
            const half = len >> 1;
            for (let j = 0; j < half; j++) {
                const a = i + j;
                const b = a + half;
                const tRe = re[b] * curRe - im[b] * curIm;
                const tIm = re[b] * curIm + im[b] * curRe;
                re[b] = re[a] - tRe;
                im[b] = im[a] - tIm;
                re[a] += tRe;
                im[a] += tIm;
                const nextRe = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe;
                curRe = nextRe;
            }
        }
    }
}

function popcount32(x: number): number {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    return ((x * 0x01010101) >>> 24) & 0x3f;
}
