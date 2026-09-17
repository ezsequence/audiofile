// audiofile/node — Node-only surface. Re-exports everything in the browser
// bundle PLUS the `child_process`/`fs`-backed ffmpeg decode path.

export * from './index.browser';

export {
    decodeToPCM,
    generateNodeFingerprint,
    type NodeDecodeOptions,
} from './fingerprint.node';
