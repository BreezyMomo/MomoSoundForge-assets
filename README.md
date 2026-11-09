# MomoSoundForge assets

Self-contained official sound library for [MomoSoundForge](https://github.com/BreezyMomo/MomoSoundForge), served at [index.json](https://breezymomo.github.io/MomoSoundForge-assets/index.json). The application supplies the editor and generic resource protocol; this repository owns sound definitions, mappings, attribution, dependency records and publishing tools. No application `samples/` checkout is required.

## Immutable build inputs

Large recordings and editable projects belong in versioned Release attachments, never Git history. A patch attachment contains `patch.json`, its SHA-256-pinned `base-index.json`, and newly sealed resource graphs. Existing audio is reused by content ID. Never replace an existing attachment or use `latest` as an input.

The repair release is `2026.11.09-orchestra-fix`. It replaces five malformed orchestra instrument graphs, restores complete mappings in the flute/violin/cello demonstrations, and removes the obsolete four-second playback limit from complete recordings. The source audit quarantined damaged cello tremolo and horn staccato takes; their uncovered high velocities reuse healthy recordings of the same pitch. Existing mappings and default demonstration PCM are preserved.

Original source licenses remain authoritative. The source packages' `source-metadata.zip` and `SHA256SUMS` retain manifests, mappings, license notices and provenance. Older `momo.sound-assets-pack/v1` attachments are gzip streams, not ZIP archives.

## Validate and publish

The editor owns the protocol implementation. The workflow checks out application commit `e0a843227894e430e6a67a03801404d5fad16225` only as a validator, installs its locked dependencies, and runs the publisher regression test. No catalog or recording is moved into the application repository.

```sh
PROTOCOL_APP_ROOT=/path/to/pinned/app node --test tools/validate-library.test.mjs
node tools/build-library.mjs --patch-dir /path/to/extracted/patch --output _audio-site
node tools/validate-library.mjs --app-root /path/to/pinned/app --site _audio-site --report validation-report.json
```

The builder checks hashes, applies the pinned patch and preserves previous immutable graph URLs. Its optional `--cache` directory stores verified downloads by SHA-256. The validator uses the editor's strict `openResourceGraph`, checks every dependency and decoded audio content ID, and exercises MIDI/velocity boundaries, alternating takes, short notes and notes near the actual transposed recording length. Complete orchestra instruments and demonstrations also require continuous velocity coverage. Known flute/cello coverage and four-second violin regressions use the real `scoreIssues` and `projectScoreIssues` implementations. Unlooped recordings retain their real finite duration.

Run `.github/workflows/pages.yml` on `main` with the fixed patch tag and `publish=false` first. Inspect the validation report and candidate artifact, then run the same revision/tag with `publish=true`. Only `main` may deploy to `github-pages`; all checks must pass before deployment. Verify the deployed catalog, empty-cache loading, browser audition, project save/reopen and export.

## Subscribe as an external library

The catalog uses `momo.remote-sound-library/v1`. Its `libraryId` is stable independently of the hosting URL; every library carries its own complete dependencies. Official and third-party libraries use the same protocol. Supplemental VCSL instruments are maintained in [MomoSoundForge-assets-vcsl-harp-sax](https://github.com/BreezyMomo/MomoSoundForge-assets-vcsl-harp-sax).

The editor subscribes by URL through deployment settings. See its [multi-library rules](https://github.com/BreezyMomo/MomoSoundForge/blob/main/docs/remote-sound-libraries.md) and [maintenance workflow](https://github.com/BreezyMomo/MomoSoundForge/blob/main/docs/builtin-resource-maintenance.md).
