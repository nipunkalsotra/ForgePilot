"""Replay archived Task B output in a CLEAN pinned Flask checkout, without inference.

Environment installation is deliberately separate. This program applies only the
immutable accepted patch; it never applies the optional editorial supplement.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.checkout.resolve()
    python = str(args.python.absolute())  # Preserve the venv executable symlink.
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    evidence = Path(__file__).resolve().parent
    manifest = json.loads((evidence / "manifest.json").read_text())
    report = {"newAgentRun": False, "commands": [], "result": "FAIL"}
    env = {k: v for k, v in os.environ.items() if not k.startswith("FLASK_")}
    env["PYTHONPATH"] = str(root / "src")

    def run(command, *, check=True):
        result = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
        report["commands"].append({"command": command, "exit": result.returncode,
                                   "stdout": result.stdout, "stderr": result.stderr})
        print(f"exit {result.returncode}: {' '.join(command[:6])}", flush=True)
        if check and result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        return result.stdout

    try:
        assert run(["git", "rev-parse", "HEAD"]).strip() == manifest["commit"]
        assert run(["git", "status", "--porcelain", "--untracked-files=all"]) == ""
        assert sha((evidence / "accepted.patch").read_bytes()) == manifest["patchSHA256"]
        for item in manifest["files"]:
            assert sha((root / item["path"]).read_bytes()) == item["baselineSHA256"]
        # Reconstruct all six accepted batches, independently of the final diff.
        provenance = json.loads((evidence / "provenance.json").read_text())
        state = {item["path"]: (root / item["path"]).read_text() for item in manifest["files"]}
        assert len(provenance["batches"]) == len(manifest["approvedChain"]) == 6
        assert sum(len(b["hunkDecisions"]) for b in provenance["batches"]) == 22
        for batch, original in zip(provenance["batches"], manifest["approvedChain"]):
            assert batch["sessions"] == original["sessions"]
            assert batch["proposalId"] == original["proposalId"]
            assert len(batch["stagingDecisions"]) == 1
            assert all(h["decision"] == "accepted" for h in batch["hunkDecisions"])
            for file in batch["payload"]["files"]:
                before = state[file["path"]]
                assert sha(before.encode()) == file["baseHash"]
                edits = []
                for edit in file["edits"]:
                    assert before.count(edit["oldText"]) == 1
                    edits.append((before.index(edit["oldText"]), edit))
                for offset, edit in sorted(edits, reverse=True):
                    state[file["path"]] = (state[file["path"]][:offset] + edit["newText"]
                                           + state[file["path"]][offset + len(edit["oldText"]):])
                recorded = next(f for f in batch["files"] if f["path"] == file["path"])
                assert sha(state[file["path"]].encode()) == recorded["afterSHA256"]
        for item in manifest["files"]:
            assert sha(state[item["path"]].encode()) == item["acceptedSHA256"]
        report["provenanceChain"] = "PASS: six exact payloads, six staging decisions, 22 hunk decisions"
        run(["git", "apply", "--check", str(evidence / "accepted.patch")])
        run(["git", "apply", str(evidence / "accepted.patch")])
        paths = run(["git", "diff", "--name-only"]).splitlines()
        assert sorted(paths) == sorted(item["path"] for item in manifest["files"])
        for item in manifest["files"]:
            assert sha((root / item["path"]).read_bytes()) == item["acceptedSHA256"]
        diff = subprocess.check_output(["git", "diff", "--no-ext-diff", "--abbrev=7"], cwd=root)
        assert diff == (evidence / "accepted.patch").read_bytes()
        (output / "replayed.patch").write_bytes(diff)
        report["integrity"] = "PASS: clean pinned baseline, exact patch and three file hashes"
        run([python, "-c", "import flask; from pathlib import Path; "
             f"assert Path(flask.__file__).is_relative_to({str(root)!r}); print(flask.__file__)"])
        run([python, "-m", "pytest", "tests/test_cli.py", "-q"])
        run([python, "-m", "pytest", "tests/test_cli.py", "tests/test_helpers.py", "tests/test_config.py", "-q"])
        help_output = run([python, "-m", "flask", "--help"])
        assert "config " in help_output
        with tempfile.TemporaryDirectory(prefix="forgepilot-taskb-app-") as fixture:
            fixture_root = Path(fixture)
            (fixture_root / "task_b_app.py").write_text(
                'from flask import Flask\napp = Flask(__name__)\n'
                'app.config.update(ORDINARY="visible-normal", COUNT=42, RATIO=1.5, FLAG=True, '
                'DISABLED=False, NOTHING=None, ITEMS=[1, "two"], MAP={"a": 1})\n'
                'for key in ("SECRET", "prefix_secret_suffix", "PaSsWoRd_demo", '
                '"x_token_value", "mixed_Key", "API_KEY", "PASSWORD", "TOKEN"):\n'
                '    app.config[key] = "FORGEPILOT_PRIVATE_MARKER_" + key\n'
            )
            env["PYTHONPATH"] += os.pathsep + fixture
            config = json.loads(run([python, "-m", "flask", "--app", "task_b_app", "config"]))
            last = report["commands"][-1]
            assert last["stderr"] == ""
            assert "FORGEPILOT_PRIVATE_MARKER_" not in last["stdout"] + last["stderr"]
            expected = dict(ORDINARY="visible-normal", COUNT=42, RATIO=1.5, FLAG=True,
                            DISABLED=False, NOTHING=None, ITEMS=[1, "two"], MAP={"a": 1})
            for key, value in expected.items():
                assert config[key] == value and type(config[key]) is type(value)
            for key in ("SECRET", "prefix_secret_suffix", "PaSsWoRd_demo", "x_token_value",
                        "mixed_Key", "API_KEY", "PASSWORD", "TOKEN", "SECRET_KEY", "SECRET_KEY_FALLBACKS"):
                assert config[key] == "***"
            assert config["DEBUG"] is False and config["TESTING"] is False
            assert config["SESSION_COOKIE_NAME"] == "session"
            assert config["PERMANENT_SESSION_LIFETIME"] == "31 days, 0:00:00"
            run([python, "-c", "from copy import deepcopy; from task_b_app import app; "
                 "from flask.cli import config_command; before=deepcopy(dict(app.config)); "
                 "r=app.test_cli_runner().invoke(config_command); assert r.exit_code == 0; "
                 "assert dict(app.config)==before; print('PASS: live app config unchanged')"])
            report["maskedJSON"] = config
        report["result"] = "PASS"
    finally:
        (output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    print("PASS: archived output replayed; no model request was made")


if __name__ == "__main__":
    main()
