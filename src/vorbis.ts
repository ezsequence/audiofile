// Vorbis Comment parser — handles FLAC and OGG/Opus containers.
// Pure byte parsing, no dependencies, works in browser and Node.
//
// FLAC: fLaC magic → metadata blocks → VORBIS_COMMENT (type 4) + PICTURE (type 6)
// OGG:  OggS pages → find comment packet (\x03vorbis or OpusTags) → Vorbis Comments
//
// Both use the same Vorbis Comment format internally: UTF-8 KEY=value pairs.

import { AudioTags, EmbeddedPicture } from './id3';

// ── FLAC ───────────────────────────────────────────────────────────

export function parseFLACTags(data: Uint8Array): AudioTags | null {
    if (data.length < 8) return null;
    // fLaC magic
    if (data[0] !== 0x66 || data[1] !== 0x4c || data[2] !== 0x61 || data[3] !== 0x43) {
        return null;
    }

    let tags: AudioTags = {};
    let off = 4;

    while (off + 4 <= data.length) {
        const byte0 = data[off];
        const isLast = (byte0 & 0x80) !== 0;
        const blockType = byte0 & 0x7f;
        const blockLen = (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3];
        off += 4;

        if (off + blockLen > data.length) break;

        if (blockType === 4) {
            // VORBIS_COMMENT
            tags = parseVorbisComments(data, off, off + blockLen);
        } else if (blockType === 6) {
            // PICTURE
            if (!tags.coverArt) {
                tags.coverArt = parseFLACPicture(data, off, off + blockLen);
            }
        }

        off += blockLen;
        if (isLast) break;
    }

    return tags;
}

// ── OGG (Vorbis / Opus) ───────────────────────────────────────────

export function parseOggTags(data: Uint8Array): AudioTags | null {
    if (data.length < 4) return null;
    // OggS magic
    if (data[0] !== 0x4f || data[1] !== 0x67 || data[2] !== 0x67 || data[3] !== 0x53) {
        return null;
    }

    // Extract the first few OGG packets — the comment header is usually packet 1 or 2
    const packets = extractOggPackets(data, 5);

    for (const pkt of packets) {
        // Vorbis comment header: \x03 + "vorbis" (7 bytes), then Vorbis Comments
        if (pkt.length > 7 && pkt[0] === 0x03 && ascii(pkt, 1, 6) === 'vorbis') {
            return parseVorbisComments(pkt, 7, pkt.length);
        }
        // Opus comment header: "OpusTags" (8 bytes), then Vorbis Comments
        if (pkt.length > 8 && ascii(pkt, 0, 8) === 'OpusTags') {
            return parseVorbisComments(pkt, 8, pkt.length);
        }
    }

    return null;
}

/** Extract packets from the first N OGG pages. */
function extractOggPackets(data: Uint8Array, maxPages: number): Uint8Array[] {
    const packets: Uint8Array[] = [];
    let pending: Uint8Array[] = [];
    let off = 0;

    for (let page = 0; page < maxPages && off + 27 <= data.length; page++) {
        // OggS magic check
        if (data[off] !== 0x4f || data[off + 1] !== 0x67 ||
            data[off + 2] !== 0x67 || data[off + 3] !== 0x53) break;

        const numSegments = data[off + 26];
        if (off + 27 + numSegments > data.length) break;

        // Read segment table
        let dataStart = off + 27 + numSegments;
        for (let s = 0; s < numSegments; s++) {
            const segSize = data[off + 27 + s];
            if (dataStart + segSize > data.length) break;
            pending.push(data.subarray(dataStart, dataStart + segSize));
            dataStart += segSize;

            if (segSize < 255) {
                // End of packet — concatenate pending segments
                packets.push(concat(pending));
                pending = [];
            }
        }

        off = dataStart;
    }

    return packets;
}

// ── Vorbis Comment format (shared) ─────────────────────────────────

/** Standard Vorbis Comment key names (case-insensitive). */
const TAG_MAP: Record<string, keyof AudioTags> = {
    title:                  'title',
    artist:                 'artist',
    album:                  'album',
    genre:                  'genre',
    date:                   'year',
    tracknumber:            'track',
    comment:                'comment',
    albumartist:            'albumArtist',
    album_artist:           'albumArtist',
    composer:               'composer',
    isrc:                   'isrc',
    // MUSICBRAINZ_TRACKID is — confusingly — the MusicBrainz *recording* id
    // in Vorbis tags. That's the value we want for cross-copy identity.
    musicbrainz_trackid:    'mbid',
    acoustid_id:            'acoustid',
};

function parseVorbisComments(
    data: Uint8Array, start: number, end: number,
): AudioTags {
    const tags: AudioTags = {};
    let off = start;

    // Vendor string
    if (off + 4 > end) return tags;
    const vendorLen = u32le(data, off); off += 4;
    off += vendorLen; // skip vendor
    if (off + 4 > end) return tags;

    // Comment count
    const count = u32le(data, off); off += 4;

    for (let i = 0; i < count && off + 4 <= end; i++) {
        const len = u32le(data, off); off += 4;
        if (off + len > end) break;

        const comment = utf8(data, off, len);
        off += len;

        const eq = comment.indexOf('=');
        if (eq < 1) continue;

        const key = comment.substring(0, eq).toLowerCase();
        const value = comment.substring(eq + 1);

        const mapped = TAG_MAP[key];
        if (mapped) {
            (tags as Record<string, string>)[mapped] = value;
        } else if (key === 'metadata_block_picture' && !tags.coverArt) {
            // OGG/Opus: base64-encoded FLAC PICTURE block
            tags.coverArt = decodeBase64Picture(value);
        }
    }

    return tags;
}

// ── FLAC PICTURE block ─────────────────────────────────────────────

function parseFLACPicture(
    data: Uint8Array, start: number, end: number,
): EmbeddedPicture | undefined {
    let off = start;
    if (off + 32 > end) return undefined;

    const pictureType = u32be(data, off); off += 4;

    const mimeLen = u32be(data, off); off += 4;
    if (off + mimeLen > end) return undefined;
    const mimeType = ascii(data, off, mimeLen) || 'image/jpeg';
    off += mimeLen;

    const descLen = u32be(data, off); off += 4;
    if (off + descLen > end) return undefined;
    const description = utf8(data, off, descLen);
    off += descLen;

    // width, height, colorDepth, numColors — skip
    off += 16;

    if (off + 4 > end) return undefined;
    const picLen = u32be(data, off); off += 4;
    if (off + picLen > end) return undefined;

    return {
        data: data.slice(off, off + picLen),
        mimeType,
        pictureType,
        description,
    };
}

/** Decode a base64-encoded FLAC PICTURE block (used in OGG/Opus comments). */
function decodeBase64Picture(b64: string): EmbeddedPicture | undefined {
    try {
        // atob works in browser; in Node, use Buffer
        let bytes: Uint8Array;
        if (typeof atob === 'function') {
            const bin = atob(b64);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
            bytes = new Uint8Array(Buffer.from(b64, 'base64'));
        }
        return parseFLACPicture(bytes, 0, bytes.length);
    } catch {
        return undefined;
    }
}

// ── Helpers ─────────────────────────────────────────────────────────

function u32le(data: Uint8Array, off: number): number {
    return (data[off] | (data[off + 1] << 8)
          | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0;
}

function u32be(data: Uint8Array, off: number): number {
    return ((data[off] << 24) | (data[off + 1] << 16)
          | (data[off + 2] << 8) | data[off + 3]) >>> 0;
}

function ascii(data: Uint8Array, off: number, len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(data[off + i]);
    return s;
}

function utf8(data: Uint8Array, off: number, len: number): string {
    return new TextDecoder('utf-8').decode(data.subarray(off, off + len));
}

function concat(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) return parts[0];
    let total = 0;
    for (const p of parts) total += p.length;
    const result = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { result.set(p, off); off += p.length; }
    return result;
}
