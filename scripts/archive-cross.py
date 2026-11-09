"""Archives native release trees, preserving symlinks and executable permissions."""
import pathlib
import stat
import sys
import tarfile
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
platform = sys.argv[1]
version = '1.4.0'
tree = root / 'dist' / 'cross' / ('NodeMend-' + platform + '-x64')
output = root / 'release' / version
output.mkdir(parents=True, exist_ok=True)
if platform == 'linux':
    target = output / ('NodeMend-' + version + '-linux-x64.tar.gz')
    with tarfile.open(target, 'w:gz') as archive:
        def permissions(info):
            if pathlib.PurePosixPath(info.name).name in ('NodeMend', 'photorec', 'chrome-sandbox', 'chrome_crashpad_handler'):
                info.mode = 0o755
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            return info
        archive.add(tree, arcname='NodeMend', filter=permissions)
else:
    target = output / ('NodeMend-' + version + '-macos-intel.zip')
    app = tree / 'NodeMend.app'
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for item in app.rglob('*'):
            if not item.is_symlink() and item.is_dir():
                continue
            name = item.relative_to(tree).as_posix()
            mode = item.lstat().st_mode
            entry = zipfile.ZipInfo(name)
            entry.create_system = 3
            if item.is_symlink():
                entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(entry, item.readlink().as_posix())
            else:
                executable = item.name in ('NodeMend', 'photorec') or 'MacOS' in item.parts
                entry.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(entry, item.read_bytes())
print(target)
