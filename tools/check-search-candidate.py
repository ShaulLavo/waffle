#!/usr/bin/env python3
"""Check transferred bytes, dependency pins, wired recipes and the source-only runtime boundary."""
import hashlib
import json
import subprocess
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()


def package_id(package):
    return package['name'], package['version'], package.get('source')


def check_relocation():
    receipt = json.loads((ROOT / 'programs-search-candidate/relocation.json').read_text())
    for entry in receipt['files']:
        assert digest(entry['newPath']) == entry['newSha256'], entry['newPath']
        if entry['classification'] == 'unchanged':
            assert entry['oldSha256'] == entry['newSha256'], entry['newPath']
        assert entry['oldCommit'] == '9ef027d7b8544be7d2d84ee59beea8adf0b33cd8'
    print(f"Relocation: {len(receipt['files'])} input mappings verified")


def check_lock():
    original = tomllib.loads((ROOT / 'programs-search-candidate/provenance/bash/shell/Cargo.lock').read_text())['package']
    current = tomllib.loads((ROOT / 'packages/sed/Cargo.lock').read_text())['package']
    frozen = {package_id(p): p for p in original}
    for package in current:
        old = frozen[package_id(package)]
        assert package.get('checksum') == old.get('checksum'), package['name']
        assert not package['name'].startswith('shell-') or package['name'] == 'shell-sed'
    print(f'Lock: {len(current)} packages use frozen identities/checksums; no shell engine')


def check_family(family, binary):
    root = ROOT / 'packages' / family
    manifest = json.loads((root / 'package.json').read_text())
    assert manifest['private'] is True
    assert not any(key in manifest for key in ['exports', 'dependencies', 'peerDependencies', 'version'])
    recipe = json.loads((root / 'build-recipe.json').read_text())
    assert recipe['sharedTools'] == '../../../tools/program-build-tools.ts'
    assert recipe['sharedToolsCommit'] == '74490abce8067d3d23b857d9774ba4f235f43a1d'
    expected_recipe = 'scripts/build-rg.ts' if family == 'ripgrep' else 'scripts/build-sed.ts'
    assert recipe['toolRecipe'] == expected_recipe
    assert recipe['familyRecipe']['root'] == 'monorepo root'
    assert recipe['familyRecipe']['waffle'] == 'packages/waffle'
    assert recipe['familyRecipe']['targetDirectory'] == f'.build/{family}'
    assert recipe['wasiSdk'] == '34.0'
    assert recipe['wasiLibc'] == '2e6fb9d8ee0c'
    assert recipe['maxMemoryBytes'] == 268435456
    assert recipe['copiedHelpers'] is False
    assert digest(f'packages/{family}/{recipe["patch"]}') == recipe['patchSha256']
    for path in root.rglob('*.ts'):
        if 'provenance' in path.relative_to(root).parts:
            continue
        source = path.read_text()
        assert 'bash-web/' not in source, path
        assert 'buildWasiShell' not in source, path
        assert 'shellTargetDirectory' not in source, path
        assert './wasi-build.ts' not in source, path
        assert './verify-wasi-guests.ts' not in source, path
        assert 'BASH_WEB_UTILITY_ARTIFACTS' not in source, path
    assert not (root / '.sources').exists()
    assert not (root / 'node_modules').exists()
    assert not list(root.rglob('*.wasm'))
    assert not list(root.rglob('wasi-build.ts'))
    assert not list(root.rglob('verify-wasi-guests.ts'))
    data = json.loads((root / 'manifest.json').read_text())
    assert data['packageName'] is None and data['exports'] is None
    assert data['programs'][0]['name'] == binary
    print(f'{family}: shared-helper caller wired; no install/runtime implementation')


def check_recipe_identity():
    root = ROOT / 'packages/ripgrep'
    recipe = json.loads((root / 'build-recipe.json').read_text())
    identity = hashlib.sha256()
    identity.update(recipe['revision'].encode())
    identity.update((root / recipe['patch']).read_bytes())
    identity.update((root / 'scripts/rg-source.ts').read_bytes())
    assert identity.hexdigest() == recipe['historicalRecipeIdentity']
    assert '--no-default-features' in (root / recipe['toolRecipe']).read_text()
    print('Ripgrep: frozen revision+patch+helper recipe identity verified')


check_relocation()
check_lock()
check_family('sed', 'sed')
check_family('ripgrep', 'rg')
check_recipe_identity()
subprocess.run(['cargo', 'metadata', '--offline', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', str(ROOT / 'packages/sed/Cargo.toml')], cwd=ROOT, stdout=subprocess.DEVNULL, check=True)
print('Sed: standalone native Cargo manifest resolves offline and locked')
