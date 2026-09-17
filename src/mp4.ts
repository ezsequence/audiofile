// MP4/M4A metadata parser — reads iTunes-style atoms (moov > udta > meta > ilst).
// Pure byte parsing, no dependencies, works in browser and Node.

import { AudioTags } from './id3';
import { GENRES } from './genres';

// ── Entry point ────────────────────────────────────────────────────

/**
 * Parse MP4/M4A metadata atoms.  Returns null if the data is not an MP4 container.
 */
export function parseMP4Tags(data: Uint8Array): AudioTags | null {
    if (data.length < 8) return null;

    // MP4 files start with an `ftyp` atom (or occasionally `moov` first)
    const firstType = ascii(data, 4, 4);
    if (firstType !== 'ftyp' && firstType !== 'moov' && firstType !== 'free') return null;

    // Navigate: moov > udta > meta > ilst
    const moov = findAtom(data, 0, data.length, 'moov');
    if (!moov) return null;

    const udta = findAtom(data, moov.start, moov.end, 'udta');
    if (!udta) return null;

    const meta = findAtom(data, udta.start, udta.end, 'meta');
    if (!meta) return null;

    // `meta` atom has a 4-byte version/flags field before its children
    const ilst = findAtom(data, meta.start + 4, meta.end, 'ilst');
    if (!ilst) return null;

    return parseIlst(data, ilst.start, ilst.end);
}

// ── Atom navigation ────────────────────────────────────────────────

interface AtomRange {
    /** First byte of atom content (after the 8-byte header). */
    start: number;
    /** One-past-last byte of the atom. */
    end: number;
}

/** Walk sibling atoms looking for one with the given 4-char type. */
function findAtom(
    data: Uint8Array, start: number, end: number, type: string,
): AtomRange | null {
    let off = start;
    while (off + 8 <= end) {
        let size = uint32(data, off);
        if (size === 1 && off + 16 <= end) {
            // 64-bit extended size
            size = uint32(data, off + 8) * 0x100000000 + uint32(data, off + 12);
            if (ascii(data, off + 4, 4) === type) {
                return { start: off + 16, end: off + size };
            }
            off += size;
            continue;
        }
        if (size < 8) break;
        if (off + size > end) break;

        if (ascii(data, off + 4, 4) === type) {
            return { start: off + 8, end: off + size };
        }
        off += size;
    }
    return null;
}

// ── ilst parsing ───────────────────────────────────────────────────

// Known atom type codes (0xA9 = © in Latin-1)
const A9 = 0xa9;
const NAM = atomKey(A9, 0x6e, 0x61, 0x6d); // ©nam
const ART = atomKey(A9, 0x41, 0x52, 0x54); // ©ART
const ALB = atomKey(A9, 0x61, 0x6c, 0x62); // ©alb
const GEN = atomKey(A9, 0x67, 0x65, 0x6e); // ©gen
const DAY = atomKey(A9, 0x64, 0x61, 0x79); // ©day
const WRT = atomKey(A9, 0x77, 0x72, 0x74); // ©wrt
const CMT = atomKey(A9, 0x63, 0x6d, 0x74); // ©cmt
const AART = atomKey(0x61, 0x41, 0x52, 0x54); // aART
const TRKN = atomKey(0x74, 0x72, 0x6b, 0x6e); // trkn
const COVR = atomKey(0x63, 0x6f, 0x76, 0x72); // covr
const GNRE = atomKey(0x67, 0x6e, 0x72, 0x65); // gnre
const FREEFORM = atomKey(0x2d, 0x2d, 0x2d, 0x2d); // "----"

function atomKey(a: number, b: number, c: number, d: number): number {
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function parseIlst(data: Uint8Array, start: number, end: number): AudioTags {
    const tags: AudioTags = {};
    let off = start;

    while (off + 8 <= end) {
        const size = uint32(data, off);
        if (size < 8 || off + size > end) break;

        const key = uint32(data, off + 4);
        const childStart = off + 8;
        const childEnd = off + size;

        // Find the `data` sub-atom inside this metadata item
        const d = findAtom(data, childStart, childEnd, 'data');
        if (d && d.start + 8 <= d.end) {
            // data atom content: 4 bytes type-indicator, 4 bytes locale, then value
            const dataType = uint32(data, d.start);
            const value = data.subarray(d.start + 8, d.end);

            switch (key) {
                case NAM:  tags.title       = utf8(value); break;
                case ART:  tags.artist      = utf8(value); break;
                case ALB:  tags.album       = utf8(value); break;
                case GEN:  tags.genre       = utf8(value); break;
                case DAY:  tags.year        = utf8(value); break;
                case WRT:  tags.composer    = utf8(value); break;
                case CMT:  tags.comment     = utf8(value); break;
                case AART: tags.albumArtist = utf8(value); break;
                case GNRE:
                    // Numeric genre — 16-bit big-endian, 1-indexed into ID3v1 table
                    if (value.length >= 2) {
                        const idx = ((value[0] << 8) | value[1]) - 1;
                        tags.genre = GENRES[idx] ?? String(idx + 1);
                    }
                    break;
                case TRKN:
                    // Binary: bytes [2..3] = track number, [4..5] = total
                    if (value.length >= 4) {
                        const num = (value[2] << 8) | value[3];
                        const total = value.length >= 6
                            ? (value[4] << 8) | value[5]
                            : 0;
                        tags.track = total ? `${num}/${total}` : String(num);
                    }
                    break;
                case COVR:
                    if (!tags.coverArt) {
                        tags.coverArt = {
                            data: value.slice(),
                            mimeType: dataType === 14 ? 'image/png' : 'image/jpeg',
                            pictureType: 3,
                            description: '',
                        };
                    }
                    break;
            }
        } else if (key === FREEFORM) {
            // iTunes-style `----:<mean>:<name>` extension atom; carries the
            // `data` sub-atom alongside `mean` and `name` siblings.
            const meanAtom = findAtom(data, childStart, childEnd, 'mean');
            const nameAtom = findAtom(data, childStart, childEnd, 'name');
            const dataAtom = findAtom(data, childStart, childEnd, 'data');
            if (meanAtom && nameAtom && dataAtom) {
                // mean/name atoms: 4 bytes flags, then UTF-8 content.
                const meanStr = utf8(data.subarray(meanAtom.start + 4, meanAtom.end)).toLowerCase();
                const nameStr = utf8(data.subarray(nameAtom.start + 4, nameAtom.end)).toLowerCase();
                if (meanStr === 'com.apple.itunes' && dataAtom.start + 8 <= dataAtom.end) {
                    const value = utf8(data.subarray(dataAtom.start + 8, dataAtom.end));
                    if (nameStr === 'isrc' && !tags.isrc) tags.isrc = value;
                    else if (nameStr === 'musicbrainz track id' && !tags.mbid) tags.mbid = value;
                    else if (nameStr === 'acoustid id' && !tags.acoustid) tags.acoustid = value;
                }
            }
        }

        off += size;
    }

    return tags;
}

// ── Helpers ─────────────────────────────────────────────────────────

function uint32(data: Uint8Array, off: number): number {
    return ((data[off] << 24) | (data[off + 1] << 16)
          | (data[off + 2] << 8) | data[off + 3]) >>> 0;
}

function ascii(data: Uint8Array, off: number, len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(data[off + i]);
    return s;
}

function utf8(data: Uint8Array): string {
    return new TextDecoder('utf-8').decode(data).replace(/\0+$/, '').trim();
}
