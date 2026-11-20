"""Compare built, VSIX and optional installed bytes; never infer identity from version."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--vsix', default='artifacts/forgepilot.vsix')
parser.add_argument('--installed', type=Path)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
sha = lambda data: hashlib.sha256(data).hexdigest()
paths = ['dist/extension.cjs', 'dist/mcp-child.cjs', 'media/agent.js',
         'media/agent.css', 'media/forgepilot.svg', 'dist/THIRD_PARTY_NOTICES.txt']
patterns = [rb'AIza[0-9A-Za-z_-]{30,}', rb'gh[pousr]_[A-Za-z0-9]{30,}',
            rb'github_pat_[A-Za-z0-9_]{30,}', rb'sk-(?:proj-)?[A-Za-z0-9_-]{30,}',
            rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----']
report = {'vsixSha256': sha(Path(args.vsix).read_bytes()), 'files': {},
          'credentialPatternMatches': []}
with zipfile.ZipFile(args.vsix) as package:
    report['entries'] = package.namelist()
    for name in paths:
        built, packed = Path(name).read_bytes(), package.read('extension/' + name)
        assert built == packed, f'Packaged bytes differ: {name}'
        row = {'built': sha(built), 'packaged': sha(packed)}
        if args.installed:
            installed = (args.installed / name).read_bytes()
            assert built == installed, f'Installed bytes differ: {name}'
            row['installed'] = sha(installed)
        row['match'] = True
        report['files'][name] = row
    manifest = json.loads(package.read('extension/package.json'))
    assert manifest['contributes'] == json.loads(Path('package.json').read_bytes())['contributes']
    if args.installed:
        assert manifest['contributes'] == json.loads((args.installed / 'package.json').read_bytes())['contributes']
    report['manifestContributionsMatch'] = True
    report['commands'] = len(manifest['contributes']['commands'])
    report['view'] = manifest['contributes']['views']['forgepilot']
    for name in package.namelist():
        if any(re.search(pattern, package.read(name)) for pattern in patterns):
            report['credentialPatternMatches'].append(name)
    report['licenseEntries'] = [n for n in package.namelist() if 'LICENSE' in n or 'NOTICES' in n]
assert not report['credentialPatternMatches'], 'Potential credential pattern in package; inspect filenames privately.'
args.output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'vsixSha256': report['vsixSha256'], 'verifiedFiles': len(paths),
                  'commands': report['commands'], 'entries': len(report['entries'])}))
