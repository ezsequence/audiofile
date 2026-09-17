// CRC32 — IEEE 802.3 polynomial (0xEDB88320), table-driven, byte-at-a-time.
// Browser- and Node-safe; no platform imports. Produces a fixed 8-char lowercase
// hex string so equality comparisons stay opaque.

const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        t[i] = c >>> 0;
    }
    return t;
})();

export function crc32(bytes: Uint8Array): string {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    const out = (c ^ 0xffffffff) >>> 0;
    return out.toString(16).padStart(8, '0');
}
