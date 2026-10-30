# Pre-metadata release specimen

These six files are exact byte and mode captures from commit `df87b324377b24802732023120a87242b9b94aa8`, tree `d48734d9eb3ee7f21b55a7ab77d57e9fc50e83c7`. The manifest records each Git blob, SHA-256, size and mode. The committed test helper pins the manifest hash.

They are inert historical test inputs for the explicit 1.8.0 to 1.9.0 example. Never install their dependencies, run their package scripts, regenerate them with the helper under test, or treat their version as a published package floor. Tests must load fresh copies and reject a missing or changed capture, without falling back to mutable repository files. Live workflow and actual repository-status checks still inspect current source.
