import type { AudioTags } from './id3';

/**
 * Canonical identifier kinds extracted from an audio file for music-rights
 * matching. Both the lib manager (server-side, fingerprinting the catalog)
 * and the show-builder Music dialog (client-side, fingerprinting the user's
 * file) use this helper so the two sides emit byte-identical strings.
 *
 * Field shape mirrors the cloud's `RightIdentifier` for the matching fields
 * it can populate from tag data; `audiosig_hk` / `audiosig_cp` / `file_id` /
 * `crc` come from elsewhere and are merged in by the caller.
 */
export interface CanonicalIdTags {
    /** ISRC code (uppercased, hyphens stripped). */
    isrc?: string;
    /** MusicBrainz Recording Id (lowercased UUID). */
    mbid?: string;
    /** AcoustID UUID (lowercased). */
    acoustid?: string;
    /** SHA-256 of the distributed audio media, from a UITS PRIV frame
     *  (Amazon/iTunes purchased downloads). Per-distribution-copy
     *  fingerprint — strong cryptographic match. */
    mediasha256?: string;
    /** Loose fallback: "title|artist", with normalization applied. */
    ta?: string;
    /** Amazon's catalog track id from the "Amazon.com Song ID: <digits>"
     *  comment on purchased MP3s. Same for every buyer of the track and
     *  stable across Amazon's re-encodes, unlike CRC / UITS. */
    amazon_song_id?: string;
}

const AMAZON_SONG_ID = /Amazon\.com Song ID:\s*(\d+)/i;

const STRIP_PAREN = /\s*[\(\[\{].*?[\)\]\}]\s*/g;
const COLLAPSE_WS = /\s+/g;
const LEADING_THE = /^the\s+/;

/** Normalize a free-text title or artist for matching. Lossy on purpose:
 *  case, parentheticals, leading "the ", and whitespace runs are dropped.
 *  Identical implementation must run server-side and client-side or matches
 *  silently diverge. */
function normalizeText(s: string): string {
    return s
        .normalize('NFC')
        .toLowerCase()
        .replace(STRIP_PAREN, ' ')
        .replace(LEADING_THE, '')
        .replace(COLLAPSE_WS, ' ')
        .trim();
}

/** Build the canonical identifier set from parsed tags. Each field is only
 *  present when the source actually carried it (and, for `ta`, when both
 *  title and artist are present after normalization). */
export function canonicalIdTags(tags: AudioTags): CanonicalIdTags {
    const out: CanonicalIdTags = {};

    if (tags.isrc) {
        const v = tags.isrc.replace(/-/g, '').toUpperCase().trim();
        if (v) out.isrc = v;
    }
    if (tags.mbid) {
        const v = tags.mbid.toLowerCase().trim();
        if (v) out.mbid = v;
    }
    if (tags.acoustid) {
        const v = tags.acoustid.toLowerCase().trim();
        if (v) out.acoustid = v;
    }
    if (tags.mediasha256) {
        const v = tags.mediasha256.toLowerCase().trim();
        if (v) out.mediasha256 = v;
    }
    if (tags.comment) {
        const m = AMAZON_SONG_ID.exec(tags.comment);
        if (m) out.amazon_song_id = m[1];
    }
    if (tags.title && tags.artist) {
        const t = normalizeText(tags.title);
        const a = normalizeText(tags.artist);
        if (t && a) out.ta = `${t}|${a}`;
    }

    return out;
}
