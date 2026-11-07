# MomoSoundForge assets

Versioned audio transport packages for [MomoSoundForge](https://github.com/BreezyMomo/MomoSoundForge). Large recordings and editable sample projects are distributed as release attachments; they are not checked into this repository's Git history.

## Restore assets

Use the asset CLI in the matching MomoSoundForge source checkout and its sound-assets.lock.json:

- npm run assets:sync — build inputs
- npm run assets:sync -- --profile audit — build inputs plus source verification material
- npm run assets:sync -- --profile archive — all archived inputs
- npm run assets:verify — offline integrity verification

The asset-storage migration is being integrated into the application repository; older application commits do not include this CLI. Always use a matching lock file and source version.

## Integrity and source records

The release lock file pins package versions, sizes, SHA-256 digests and logical file manifests. SHA256SUMS also covers the metadata attachment. source-metadata.zip includes collection manifests, mappings, original license notices and provenance records. Original source licenses remain authoritative; no blanket license is assigned to the included editable projects by this repository.

Packages use the documented momo.sound-assets-pack/v1 streaming format inside gzip. They are not ZIP/tar archives. Do not replace an existing attachment with different content; publish a new version instead.

Application builds and ordinary tests never download assets implicitly. Synchronize explicitly before building.
