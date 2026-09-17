// audiofile/browser — browser-safe surface. No Node-only imports (no
// `child_process`, no `fs`). Consuming SPA bundlers can import this entry
// directly without needing to shim `child_process`.

export {
    fingerprintPCM,
    fingerprintSimilarity,
    hashString,
    TARGET_SAMPLE_RATE,
    type AudioFingerprint,
} from './fingerprint';

export {
    generateBrowserFingerprint,
} from './fingerprint.browser';

export {
    parseAudioTags,
    type AudioTags,
    type EmbeddedPicture,
} from './id3';

export { crc32 } from './crc';
export { canonicalIdTags, type CanonicalIdTags } from './canonical';
