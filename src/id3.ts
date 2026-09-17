// Audio tag parser — supports ID3v1/v2 (MP3), MP4/M4A atoms, FLAC, and OGG/Opus.
// Pure byte parsing, no dependencies, works in browser and Node.
//
// Browser:  parseAudioTags(new Uint8Array(await file.arrayBuffer()))
// Node:     parseAudioTags(fs.readFileSync(path))

import { parseMP4Tags } from './mp4';
import { parseFLACTags, parseOggTags } from './vorbis';
import { GENRES } from './genres';

// ── Public types ───────────────────────────────────────────────────

export interface AudioTags {
    title?: string;
    artist?: string;
    album?: string;
    genre?: string;
    year?: string;
    track?: string;
    comment?: string;
    albumArtist?: string;
    composer?: string;
    coverArt?: EmbeddedPicture;

    // Stable cross-copy identifiers. Present in well-tagged copies; absent
    // in casual rips. Read in priority order for music-rights matching.
    /** International Standard Recording Code. ID3v2 `TSRC` frame; MP4 `----`
     *  freeform `com.apple.iTunes:ISRC`; Vorbis `ISRC` key. */
    isrc?: string;
    /** MusicBrainz Recording Id (UUID). ID3v2 `UFID` frame with owner
     *  `http://musicbrainz.org`; MP4 `----:com.apple.iTunes:MusicBrainz Track Id`;
     *  Vorbis `MUSICBRAINZ_TRACKID`. */
    mbid?: string;
    /** AcoustID (UUID — paired with Chromaprint lookups). ID3v2
     *  `TXXX:Acoustid Id`; MP4 `----:com.apple.iTunes:Acoustid Id`;
     *  Vorbis `ACOUSTID_ID`. */
    acoustid?: string;
    /** SHA-256 of the distributed audio media, extracted from a UITS
     *  PRIV frame (Amazon / iTunes purchased downloads). Identifies an
     *  exact distribution copy — stronger than CRC32 and per-file. */
    mediasha256?: string;
}

export interface EmbeddedPicture {
    /** Raw image bytes. */
    data: Uint8Array;
    /** MIME type (e.g. "image/jpeg"). */
    mimeType: string;
    /** ID3 picture‐type code (3 = front cover). */
    pictureType: number;
    /** Picture description from the tag. */
    description: string;
}

// ── Entry point ────────────────────────────────────────────────────

/**
 * Parse audio metadata tags from raw file bytes.
 * Auto-detects format: ID3v2 (MP3), MP4/M4A, FLAC, OGG/Opus, then ID3v1 fallback.
 */
export function parseAudioTags(data: Uint8Array): AudioTags {
    return parseID3v2(data)
        ?? parseMP4Tags(data)
        ?? parseFLACTags(data)
        ?? parseOggTags(data)
        ?? parseID3v1(data)
        ?? {};
}

// ── ID3v2 ──────────────────────────────────────────────────────────

/** Map ID3v2.2 (3‑char) frame IDs → ID3v2.3+ (4‑char). */
const V22_MAP: Record<string, string> = {
    TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TCO: 'TCON',
    TYE: 'TYER', TRK: 'TRCK', TP2: 'TPE2', TCM: 'TCOM',
    COM: 'COMM', PIC: 'APIC',
};

function parseID3v2(data: Uint8Array): AudioTags | null {
    if (data.length < 10) return null;
    // Magic "ID3"
    if (data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) return null;

    const ver = data[3]; // 2, 3, or 4
    if (ver < 2 || ver > 4) return null;

    const flags = data[5];
    const tagSize = syncsafe(data, 6);
    const tagEnd = Math.min(10 + tagSize, data.length);

    let offset = 10;

    // Skip extended header if flagged
    if (flags & 0x40) {
        const extSize = ver === 4
            ? syncsafe(data, offset)
            : uint32be(data, offset) + 4;
        offset += extSize;
    }

    const isV22 = ver === 2;
    const headerLen = isV22 ? 6 : 10;
    const tags: AudioTags = {};

    while (offset + headerLen <= tagEnd) {
        let id: string;
        let size: number;

        if (isV22) {
            id = latin1(data, offset, 3);
            size = (data[offset + 3] << 16) | (data[offset + 4] << 8) | data[offset + 5];
            offset += 6;
        } else {
            id = latin1(data, offset, 4);
            size = ver === 4 ? syncsafe(data, offset + 4) : uint32be(data, offset + 4);
            offset += 10;
        }

        if (size === 0 || id[0] === '\0') break;          // padding
        if (offset + size > tagEnd) break;                  // truncated

        const frame = data.subarray(offset, offset + size);
        offset += size;

        const key = isV22 ? (V22_MAP[id] ?? id) : id;

        switch (key) {
            case 'TIT2': tags.title       = textFrame(frame); break;
            case 'TPE1': tags.artist      = textFrame(frame); break;
            case 'TALB': tags.album       = textFrame(frame); break;
            case 'TCON': tags.genre       = parseGenre(textFrame(frame)); break;
            case 'TDRC':                                       // v2.4
            case 'TYER': tags.year        = textFrame(frame); break;
            case 'TRCK': tags.track       = textFrame(frame); break;
            case 'TPE2': tags.albumArtist = textFrame(frame); break;
            case 'TCOM': tags.composer    = textFrame(frame); break;
            case 'COMM': tags.comment     = commFrame(frame); break;
            case 'TSRC': tags.isrc        = textFrame(frame); break;
            case 'UFID': {
                const parsed = ufidFrame(frame);
                if (parsed && parsed.owner === 'http://musicbrainz.org') {
                    tags.mbid = parsed.identifier;
                }
                break;
            }
            case 'TXXX': {
                const parsed = txxxFrame(frame);
                if (parsed) {
                    // MusicBrainz Picard / Mp3tag use these exact descriptions.
                    const desc = parsed.description.toLowerCase();
                    if (desc === 'acoustid id') tags.acoustid = parsed.value;
                    else if (desc === 'musicbrainz release track id' || desc === 'musicbrainz track id') {
                        // Reserve `mbid` for the recording id (from UFID); only fall back here.
                        if (!tags.mbid) tags.mbid = parsed.value;
                    } else if (desc === 'isrc' && !tags.isrc) {
                        tags.isrc = parsed.value;
                    }
                }
                break;
            }
            case 'PRIV': {
                // UITS payloads from Amazon / iTunes purchases ride in PRIV.
                // The owner identifier varies ("UITS", "Amazon UITS Signature",
                // etc.), so we ignore owner and just sniff the binary tail for
                // the UITS XML envelope.
                const uits = parseUITS(frame);
                if (uits) {
                    if (uits.isrc && !tags.isrc) tags.isrc = uits.isrc;
                    if (uits.mediasha256 && !tags.mediasha256) tags.mediasha256 = uits.mediasha256;
                }
                break;
            }
            case 'APIC':
                if (!tags.coverArt) {
                    tags.coverArt = isV22 && id === 'PIC'
                        ? picFrame(frame)
                        : apicFrame(frame);
                }
                break;
        }
    }

    return tags;
}

/** ID3v2 PRIV frame: <owner-id, latin1, null-term> <binary private data>.
 *  We sniff the data for a UITS XML envelope and pull two fields:
 *  AssetID[@type="ISRC"] and Media[@algorithm="SHA256"]. Returns null if
 *  the frame doesn't look like UITS. */
function parseUITS(frame: Uint8Array): { isrc?: string; mediasha256?: string } | null {
    // Skip the owner identifier (null-terminated latin1).
    const nullPos = findNull(frame, 0, false);
    if (nullPos >= frame.length) return null;
    const dataStart = nullPos + 1;
    if (dataStart >= frame.length) return null;
    let text: string;
    try {
        text = new TextDecoder('utf-8').decode(frame.subarray(dataStart));
    } catch {
        return null;
    }
    // Cheap content sniff — the schema is fixed enough that a quick substring
    // check beats spinning up a real XML parser, and avoids a dependency.
    if (!/<uits[: >]/i.test(text) && text.indexOf('UITS') < 0) return null;
    const isrcMatch = text.match(/<AssetID\b[^>]*\btype\s*=\s*"ISRC"[^>]*>([^<]+)<\/AssetID>/i);
    const mediaMatch = text.match(/<Media\b[^>]*\balgorithm\s*=\s*"SHA256"[^>]*>([^<]+)<\/Media>/i);
    const result: { isrc?: string; mediasha256?: string } = {};
    if (isrcMatch) {
        const v = isrcMatch[1].trim();
        if (v) result.isrc = v;
    }
    if (mediaMatch) {
        const v = mediaMatch[1].trim().toLowerCase();
        if (v) result.mediasha256 = v;
    }
    return Object.keys(result).length > 0 ? result : null;
}

/** UFID frame: <owner-id, latin1, null-term> <identifier, binary, no null-term>.
 *  Owner identifies the namespace (e.g. `http://musicbrainz.org`); identifier
 *  is opaque bytes — we decode as latin-1 since the MB UUIDs are ASCII. */
function ufidFrame(frame: Uint8Array): { owner: string; identifier: string } | undefined {
    const nullPos = findNull(frame, 0, false);
    if (nullPos >= frame.length) return undefined;
    const owner = latin1(frame, 0, nullPos);
    const identifier = latin1(frame, nullPos + 1, frame.length - nullPos - 1);
    if (!owner || !identifier) return undefined;
    return { owner, identifier: identifier.trim() };
}

/** TXXX frame: <encoding> <description, null-term in encoding> <value, in encoding>.
 *  Used for arbitrary key/value pairs — we look up by description. */
function txxxFrame(frame: Uint8Array): { description: string; value: string } | undefined {
    if (frame.length < 2) return undefined;
    const enc = frame[0];
    const descEnd = findNull(frame, 1, isWide(enc));
    const description = decodeText(frame.subarray(1, descEnd), enc).trim();
    const valueStart = descEnd + nullWidth(enc);
    if (valueStart >= frame.length) return undefined;
    const value = decodeText(frame.subarray(valueStart), enc).trim();
    if (!description || !value) return undefined;
    return { description, value };
}

// ── ID3v1 (fallback) ───────────────────────────────────────────────

function parseID3v1(data: Uint8Array): AudioTags | null {
    if (data.length < 128) return null;
    const start = data.length - 128;
    // Magic "TAG"
    if (data[start] !== 0x54 || data[start + 1] !== 0x41 || data[start + 2] !== 0x47) {
        return null;
    }

    const title   = latin1Trimmed(data, start + 3,  30);
    const artist  = latin1Trimmed(data, start + 33, 30);
    const album   = latin1Trimmed(data, start + 63, 30);
    const year    = latin1Trimmed(data, start + 93, 4);
    const genreId = data[start + 127];

    // ID3v1.1: if comment byte 28 is 0x00 and byte 29 is nonzero → track number
    let comment: string | undefined;
    let track: string | undefined;
    if (data[start + 125] === 0 && data[start + 126] !== 0) {
        comment = latin1Trimmed(data, start + 97, 28);
        track = String(data[start + 126]);
    } else {
        comment = latin1Trimmed(data, start + 97, 30);
    }

    return {
        title:   title   || undefined,
        artist:  artist  || undefined,
        album:   album   || undefined,
        year:    year    || undefined,
        genre:   GENRES[genreId],
        track,
        comment: comment || undefined,
    };
}

// ── Frame decoders ─────────────────────────────────────────────────

function textFrame(frame: Uint8Array): string | undefined {
    if (frame.length < 2) return undefined;
    return decodeText(frame.subarray(1), frame[0]).trim() || undefined;
}

function commFrame(frame: Uint8Array): string | undefined {
    // encoding(1) + language(3) + short‐description(null‑term) + text
    if (frame.length < 5) return undefined;
    const enc = frame[0];
    let pos = 4; // skip encoding + 3‑byte language
    const descEnd = findNull(frame, pos, isWide(enc));
    pos = descEnd + nullWidth(enc);
    return decodeText(frame.subarray(pos), enc).trim() || undefined;
}

/** APIC frame (ID3v2.3/v2.4). */
function apicFrame(frame: Uint8Array): EmbeddedPicture | undefined {
    if (frame.length < 4) return undefined;
    const enc = frame[0];

    // MIME type — always Latin‑1, single‑byte null terminated
    const mimeEnd = findNull(frame, 1, false);
    const mimeType = latin1(frame, 1, mimeEnd - 1) || 'image/jpeg';
    let pos = mimeEnd + 1;

    const pictureType = frame[pos++];

    // Description — null terminated in *enc* encoding
    const descEnd = findNull(frame, pos, isWide(enc));
    const description = decodeText(frame.subarray(pos, descEnd), enc).trim();
    pos = descEnd + nullWidth(enc);

    if (pos >= frame.length) return undefined;
    return { data: frame.slice(pos), mimeType, pictureType, description };
}

/** PIC frame (ID3v2.2 — 3‑char image format instead of MIME string). */
function picFrame(frame: Uint8Array): EmbeddedPicture | undefined {
    if (frame.length < 6) return undefined;
    const enc = frame[0];
    const fmt = latin1(frame, 1, 3).toUpperCase();
    const mimeType = fmt === 'PNG' ? 'image/png'
                   : fmt === 'BMP' ? 'image/bmp'
                   : 'image/jpeg';
    const pictureType = frame[4];
    let pos = 5;
    const descEnd = findNull(frame, pos, isWide(enc));
    const description = decodeText(frame.subarray(pos, descEnd), enc).trim();
    pos = descEnd + nullWidth(enc);
    if (pos >= frame.length) return undefined;
    return { data: frame.slice(pos), mimeType, pictureType, description };
}

// ── Text encoding helpers ──────────────────────────────────────────

function isWide(enc: number): boolean { return enc === 1 || enc === 2; }
function nullWidth(enc: number): number { return isWide(enc) ? 2 : 1; }

function decodeText(bytes: Uint8Array, encoding: number): string {
    // Strip trailing null terminators
    let end = bytes.length;
    if (isWide(encoding)) {
        while (end >= 2 && bytes[end - 1] === 0 && bytes[end - 2] === 0) end -= 2;
    } else {
        while (end > 0 && bytes[end - 1] === 0) end--;
    }
    const trimmed = bytes.subarray(0, end);

    switch (encoding) {
        case 1:  return utf16BOM(trimmed);
        case 2:  return new TextDecoder('utf-16be').decode(trimmed);
        case 3:  return new TextDecoder('utf-8').decode(trimmed);
        default: return latin1(trimmed, 0, trimmed.length); // 0 = ISO‑8859‑1
    }
}

function utf16BOM(data: Uint8Array): string {
    if (data.length < 2) return '';
    const le = data[0] === 0xff && data[1] === 0xfe;
    return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(data.subarray(2));
}

function latin1(data: Uint8Array, offset: number, length: number): string {
    let s = '';
    const end = Math.min(offset + length, data.length);
    for (let i = offset; i < end; i++) {
        if (data[i] === 0) break;
        s += String.fromCharCode(data[i]);
    }
    return s;
}

function latin1Trimmed(data: Uint8Array, offset: number, length: number): string {
    return latin1(data, offset, length).replace(/\s+$/, '');
}

/** Find position of null terminator (single‑byte or double‑byte). */
function findNull(data: Uint8Array, offset: number, wide: boolean): number {
    if (wide) {
        for (let i = offset; i < data.length - 1; i += 2) {
            if (data[i] === 0 && data[i + 1] === 0) return i;
        }
    } else {
        for (let i = offset; i < data.length; i++) {
            if (data[i] === 0) return i;
        }
    }
    return data.length;
}

// ── Integer helpers ────────────────────────────────────────────────

function syncsafe(data: Uint8Array, off: number): number {
    return ((data[off] & 0x7f) << 21)
         | ((data[off + 1] & 0x7f) << 14)
         | ((data[off + 2] & 0x7f) << 7)
         | (data[off + 3] & 0x7f);
}

function uint32be(data: Uint8Array, off: number): number {
    return ((data[off] << 24) | (data[off + 1] << 16)
          | (data[off + 2] << 8) | data[off + 3]) >>> 0;
}

// ── Genre parsing ──────────────────────────────────────────────────

function parseGenre(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    // "(17)" or "(17)Rock" — extract the parenthesized index
    const m = raw.match(/^\((\d+)\)(.*)$/);
    if (m) {
        const name = GENRES[Number(m[1])];
        return m[2] || name || raw;
    }
    // Plain number "17"
    if (/^\d+$/.test(raw)) {
        return GENRES[Number(raw)] ?? raw;
    }
    return raw;
}

