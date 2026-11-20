# Task B acceptance archive

This package preserves the original, review-assisted TrueForge acceptance output.
It is not a new autonomous run. Initial generation session:
`01m7se73xvn31zsj2sdwh36wyc`; final passing correction:
`01m7sgcvvb0ysapthbdbnvd123`. Six approved batches and 22 explicit automated
native-host hunk decisions were required. Physical clicks were not verified.

The exact accepted patch has SHA-256
`e4b549bc955fb604c9f22169ae90dc0998fb8e55274f70cfafdfb483b919272e`.
The original local files in `artifacts/flask-taskb-approved/` and
`artifacts/final-taskb-*.json` were read without editing. `manifest.json` is a
byte-for-byte copy of the original manifest. `accepted.patch` is a byte-for-byte
copy of the accepted patch, including its original whitespace defect.

`provenance.json` is a later Phase 5 extraction, with source-artifact checksums,
exact proposal payloads, per-file hash transitions, recorded staging decisions,
22 hunk decisions and recorded acceptance commands. The six payloads reconstruct
the accepted texts exactly from the archived originals. `server-provenance.json`
records a separate read-only check against all six persisted TrueForge sessions:
the payloads match, staging permissions correlate by tool/source IDs, and all
six executions terminated successfully. These JSON files are engineering records,
not cryptographically signed server attestations. Full raw histories are not
redistributed. Original test-file CERN attribution remains in the patch;
`FLASK-LICENSE.txt` preserves Flask's BSD license. No provider credentials are included.

## Reproduce without model requests

Prerequisites: Git, uv (or equivalent venv/pip setup), Python 3.12, network access
for initial source/dependency download. The actual reconstruction and functional
tests run locally without inference. Keep the venv outside the clean checkout.
Run from the ForgePilot repository root; choose paths that do not already exist:

```sh
git clone --no-checkout https://github.com/pallets/flask.git /tmp/flask-taskb-replay
git -C /tmp/flask-taskb-replay checkout --detach 22d924701a6ae2e4cd01e9a15bbaf3946094af65
git -C /tmp/flask-taskb-replay status --porcelain
uv venv --python 3.12 /tmp/flask-taskb-venv
uv pip install --python /tmp/flask-taskb-venv/bin/python -r docs/evidence/task-b/requirements.txt
uv pip install --python /tmp/flask-taskb-venv/bin/python --no-deps --editable /tmp/flask-taskb-replay
(cd docs/evidence/task-b && sha256sum -c accepted.patch.sha256)
python docs/evidence/task-b/replay.py \
  --checkout /tmp/flask-taskb-replay \
  --python /tmp/flask-taskb-venv/bin/python \
  --output /tmp/flask-taskb-results
```

The runner refuses a dirty or incorrectly pinned checkout, verifies baseline
hashes, checks/applies only the original patch, verifies all accepted hashes and
exactly three changed files, and writes the generated diff and command results.
It checks that Flask imports from this checkout, then runs:

```sh
python -m pytest tests/test_cli.py -q
python -m pytest tests/test_cli.py tests/test_helpers.py tests/test_config.py -q
python -m flask --help
python -m flask --app task_b_app config
```

The runner creates `task_b_app` in a separate temporary directory and selects it
explicitly with `--app` and `PYTHONPATH`. It verifies strings, finite numbers,
booleans, null/list/dict values, standard defaults, SECRET/PASSWORD/TOKEN/KEY and
mixed-case names, no marker in stdout/stderr, valid JSON and unchanged live app
configuration. Results of the actual Phase 5 run are in `replay-results.json`:
**59 CLI tests and 113 combined tests passed**, all commands exit 0.
Global help may emit Flask's existing no-app warning; the fixture command has
empty stderr. A failed replay leaves its checkout intact for investigation;
start another clean checkout for a retry.

## Original quality findings and optional editorial supplement

The original accepted implementation passes functional checks and a strict
Sphinx build with inventory network access. It fails Ruff 0.14.14 import ordering
and blank-line whitespace checks, and its test file needs formatting. The two
configuration documentation sections duplicate each other. Moving the existing
`run` decorator reverses the order of most run-help options, and the short help
changes unnecessarily. Existing CLI tests pass; the supplement restores the exact
upstream option order and help.

`editorial-supplement.patch` was **manually produced during Phase 5**, using Ruff
for formatting. It restores the upstream run decorator/help, sorts imports,
cleans whitespace, adds an explicit test exit-code assertion, and consolidates
the documentation with application selection and serialization/masking limits.
It is separate from the original accepted artifact and its hashes are in
`editorial-manifest.json`. After preserving the original replay results, optionally
apply it in a separate disposable checkout already containing `accepted.patch`:

```sh
git -C /path/to/separate-replay apply "$PWD/docs/evidence/task-b/editorial-supplement.patch"
```

The supplemented checkout passed **113 tests**, Ruff lint/format and strict
Sphinx. Neither that correction nor its checks count as autonomous generation.
Masking examines top-level configuration key names, not arbitrary secret values
or nested keys. Non-native values use `str`; non-finite numbers and arbitrary
custom serializers were not accepted as part of this fixture. This is a benchmark
archive, not an upstream Flask release or a claim of complete secret detection.
