# Native snapshot corpus

The first 12 inputs are saved recordings from Explainable UI commit `a7512a8d35354c104aab0c74cd3b1f24fb5ccf21` under `test/fixtures/payment-subflow` and `test/fixtures/subflow-tracing`. Cases cover tracked and default modes, nested and repeated mounts, fan-out, disabled reads, redaction, a seedless log and pause/resume on the same and a fresh executor.

The last six were captured through the public engine at `footprintjs@14.1.0` and `foottrace@2.2.0`: a flat run, a lazy mount and two parallel child mounts, each in the full and delta encodings.

Each expected hash is taken directly from one own field of the corresponding viewer-produced `RecordScope`, with undefined object properties omitted, object keys sorted and array order retained. The test compares field names, values, log addresses and scope order. These are recorded data and oracle outputs, so the tests need only the Foottrace checkout.
