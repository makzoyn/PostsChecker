"""Собирает версию для Orion и архив для друга из папки extension.

Запуск из корня проекта: python tools/build.py

- orion/extension: та же папка расширения, но у значка есть всплывающее окно.
  На iPhone клик по значку без окна ничего не показывает.
- dist/VkViews.zip: папка extension и ИНСТРУКЦИЯ.txt для передачи другу.
"""
import json
import pathlib
import re
import shutil
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'extension'
ORION = ROOT / 'orion' / 'extension'
DIST = ROOT / 'dist'
INSTRUCTIONS = ROOT / 'ИНСТРУКЦИЯ.txt'
FRIEND_ZIP = DIST / 'VkViews.zip'

# Признаки ключей доступа и ID приложений, которым не место в публикуемых файлах.
SECRET = re.compile(r'vk1\.a\.|access_token\s*[:=]\s*[\'"]\w{20,}|client_id\s*[:=]\s*[\'"]?\d{5,}')
TEXT_SUFFIXES = {'.js', '.json', '.html', '.css', '.txt'}


def source_files():
    return sorted(path for path in SOURCE.rglob('*') if path.is_file())


def build_orion():
    if ORION.exists():
        shutil.rmtree(ORION)
    shutil.copytree(SOURCE, ORION)
    manifest_path = ORION / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    manifest['action']['default_popup'] = 'popup.html'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return manifest


def build_friend_zip():
    DIST.mkdir(exist_ok=True)
    with zipfile.ZipFile(FRIEND_ZIP, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.write(INSTRUCTIONS, f'VkViews/{INSTRUCTIONS.name}')
        for path in source_files():
            archive.write(path, f'VkViews/{path.relative_to(ROOT).as_posix()}')


def check_extension(folder, manifest):
    referenced = [manifest['background']['service_worker'], manifest['options_ui']['page'], *manifest['icons'].values()]
    referenced += [name for script in manifest['content_scripts'] for name in script['js']]
    if manifest['action'].get('default_popup'):
        referenced.append(manifest['action']['default_popup'])
    missing = [name for name in referenced if not (folder / name).exists()]
    assert not missing, f'{folder}: нет файлов {missing}'
    for path in folder.rglob('*'):
        if path.suffix in TEXT_SUFFIXES:
            assert not SECRET.search(path.read_text(encoding='utf-8')), f'похоже на ключ: {path}'


def check_orion_matches_source():
    for path in source_files():
        copy = ORION / path.relative_to(SOURCE)
        if path.name != 'manifest.json':
            assert copy.read_bytes() == path.read_bytes(), f'папка orion устарела: {copy}'


def check_friend_zip():
    with zipfile.ZipFile(FRIEND_ZIP) as archive:
        assert archive.testzip() is None
        for path in source_files():
            assert archive.read(f'VkViews/{path.relative_to(ROOT).as_posix()}') == path.read_bytes()


def main():
    source_manifest = json.loads((SOURCE / 'manifest.json').read_text(encoding='utf-8'))
    assert 'default_popup' not in source_manifest['action'], 'на компьютере клик по значку должен сразу открывать дашборд'
    check_extension(SOURCE, source_manifest)

    orion_manifest = build_orion()
    check_extension(ORION, orion_manifest)
    check_orion_matches_source()

    build_friend_zip()
    check_friend_zip()

    print(f'Версия {source_manifest["version"]}')
    print(f'Orion: {ORION.relative_to(ROOT)}')
    print(f'Для друга: {FRIEND_ZIP.relative_to(ROOT)} ({round(FRIEND_ZIP.stat().st_size / 1024, 1)} КБ)')
    print('Все проверки пройдены')


if __name__ == '__main__':
    main()
