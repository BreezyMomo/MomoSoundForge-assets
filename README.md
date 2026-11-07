# MomoSoundForge assets

Versioned audio transport packages for [MomoSoundForge](https://github.com/BreezyMomo/MomoSoundForge). Large recordings and editable sample projects are distributed as release attachments; they are not checked into this repository's Git history.

## Restore assets

Use the asset CLI in the matching MomoSoundForge source checkout and its sound-assets.lock.json:

- npm run assets:sync — build inputs
- npm run assets:sync -- --profile audit — build inputs plus source verification material
- npm run assets:sync -- --profile archive — all archived inputs
- npm run assets:verify — offline integrity verification

The matching application checkout supplies this CLI. Always use its committed lock file and source version together; do not mix inputs from another revision.

## Integrity and source records

The release lock file pins package versions, sizes, SHA-256 digests and logical file manifests. SHA256SUMS also covers the metadata attachment. source-metadata.zip includes collection manifests, mappings, original license notices and provenance records. Original source licenses remain authoritative; no blanket license is assigned to the included editable projects by this repository.

Packages use the documented momo.sound-assets-pack/v1 streaming format inside gzip. They are not ZIP/tar archives. Do not replace an existing attachment with different content; publish a new version instead.

Application builds and ordinary tests never download assets implicitly. Synchronize explicitly before building.

## Runtime audio on GitHub Pages

The separate runtime library is published at https://breezymomo.github.io/MomoSoundForge-assets/ through `.github/workflows/pages.yml`. Git history still contains no audio files. Release attachments remain the pinned build inputs; Pages serves generated playback files and license notices, not those input archives.

Run the workflow on `main` with the application's full commit SHA and `publish=false` first. It restores pinned inputs, runs the application and audio tests, requires the generated catalog to match the commit, and checks every staged file and the site size. After a successful candidate, run the same SHA with `publish=true`. Only `main` may deploy to the `github-pages` environment.

Publish and verify the audio site before advancing the editor's catalog. The editor repository sets Actions variable `SOUND_LIBRARY_URL` to this Pages URL and verifies remote hashes and CORS before deploying. Never replace release attachments, commit generated audio to Git, or use a moving `latest` release as a source.

For current deployment evidence and application revisions, see the application's `docs/github-audio-pages.md`.

## Subscribe as an external library

The editor's provider-neutral catalog is `https://breezymomo.github.io/MomoSoundForge-assets/index.json` (`momo.remote-sound-library/v1`). This is distinct from the deployment integrity `manifest.json` and from a personal folder library index. It includes the complete dependency descriptions for resources; generated graphs and audio live beside the catalog, including the `remote/` directory.

Use the same protocol for additional category or team libraries on any HTTPS static service with CORS. Keep each library's `libraryId` stable when moving hosts. See the application's `docs/remote-sound-libraries.md` and `docs/handoff-multi-libraries.md` for publishing commands, acquisition sources, licensing checks and end-to-end validation. This repository remains the official library's build-input and publishing repository; additional subscriptions do not have to be GitHub repositories.
