# Source links from FootPrint engine recordings

Each JSON file is the output of the matching `make-real-engine-record*.cjs` probe, reproduced with FootPrint 14.0.0. `engineRecords.test.ts` reads the JSON directly so the ordinary Foottrace checks need only the committed files. The scripts reconstruct the input charts. Run them in a separate workspace with the producer installed when deliberately refreshing a fixture. The packaged Foottrace reader carries none of these test recordings.

| Recording | Generator |
| --- | --- |
| `real-engine-record-full-and-delta.json` | `make-real-engine-record.cjs` (FootPrint 14.0.0) |
| `real-record-between.json` | `make-real-engine-record-append-between.cjs` |
| `real-record-path-rule.json` | `make-real-engine-record-path-rule.cjs` |
| `real-record-union.json` | `make-real-engine-record-union.cjs` |
