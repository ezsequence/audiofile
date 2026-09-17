# audiofile

Dependency-free audio **identification** helpers for the browser and Node:

- **Tag parsing** — ID3v1/v2 (MP3), MP4/M4A atoms, FLAC and OGG/Opus Vorbis
  comments, including embedded cover art. Pure byte parsing; no decoder.
- **Canonical identifiers** — the stable, cross-copy ids a well-tagged file
  carries (ISRC, MusicBrainz recording id, AcoustID, UITS media hash, Amazon
  catalog track id) plus a normalized `title|artist` fallback, all emitted in
  one byte-identical form so two sides of a match never diverge.
- **Acoustic fingerprint** — a Haitsma-Kalker sub-fingerprint over mono PCM.
  Amplitude-invariant, so it survives loudness normalization, moderate
  compression and re-encoding of the same recording.
- **CRC32** over raw bytes for exact-copy matching.

The intended use is proving that two files are the *same recording* (for
example, that a listener's purchased track is the one a light show was
sequenced against) without ever moving the audio itself: every helper returns
short strings that can be compared server-side.

## Entry points

```ts
// Browser (no Node imports; decodes via Web Audio):
import { parseAudioTags, canonicalIdTags, crc32, generateBrowserFingerprint } from 'audiofile/browser';

// Node (adds an ffmpeg-backed decoder):
import { parseAudioTags, canonicalIdTags, crc32, generateNodeFingerprint } from 'audiofile/node';
```

The bare `audiofile` specifier resolves to the Node build under Node and the
browser build under bundlers that honor the `browser` export condition.

## Usage

```ts
const bytes = new Uint8Array(await file.arrayBuffer());   // or fs.readFileSync(path)

const tags = parseAudioTags(bytes);       // { title, artist, album, isrc, mbid, coverArt, ... }
const ids  = canonicalIdTags(tags);       // { isrc, mbid, acoustid, mediasha256, amazon_song_id, ta }
const crc  = crc32(bytes);                // 8 lowercase hex chars

// Browser: decodes with AudioContext, resamples to 44.1 kHz mono.
const fp = await generateBrowserFingerprint(file);        // { hash, subprints, duration }

// Node: decodes with ffmpeg (PATH by default, or a bundled binary).
const fp = await generateNodeFingerprint(path, { ffmpegPath: '/opt/ffmpeg/ffmpeg' });

fingerprintSimilarity(fpA, fpB);          // 0..1 over the shared prefix of sub-fingerprints
```

`fingerprintPCM(mono, sampleRate)` is the platform-independent core if you
already have PCM; decode to mono at `TARGET_SAMPLE_RATE` (44100) so results
are comparable across platforms.

## Design notes

- Identifier kinds are **field-scoped**: an ISRC only ever compares to an
  ISRC, a fingerprint hash to a fingerprint hash. Consumers should never
  match one kind against another.
- `ta` (normalized title|artist) is a loose fallback for untagged-id files.
  Case, parentheticals, a leading "the" and whitespace runs are dropped; both
  halves must be present.
- The fingerprint `hash` is a compact equality key derived from coarse
  sub-fingerprints; `subprints` carries the per-frame bits for graded
  similarity scoring.

## Building

```
pnpm install
pnpm build          # esbuild bundles (browser ESM, Node ESM + CJS) + bundled .d.ts
pnpm exec tsc -p tsconfig.json
```

## License

Copyright ©EZSequence.

Licensed under the GNU Affero General Public License, version 3.0 only —
see [LICENSE](LICENSE). You are free to use, study, modify, and redistribute
this code under the AGPL's terms.

The copyright holder retains full rights to the source and separately offers
commercial (dual) licensing on request.
