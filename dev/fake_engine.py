"""開発用の偽エンジン。`SUKOSHI_TAKO_ENGINE=fake` のときにプラグインが起動する。

本物のエンジンと同じ約束で動く:
- 入力ファイル(`SUKOSHI_TAKO_INPUT`)を毎フレーム読む。
- 遊んでいる間だけ、動く模様を新しい POSIX 共有メモリへ生の RGB で書き、
  標準出力に `@frame <名前> <幅> <高さ>` を出す。ターミナルが読んで unlink する。
- メニューの操作(3 行目の単発の操作)に応じて `@state` を出す。
- 受け取った入力を `@hud` に映すので、キーとマウスが届いているかを目で確かめられる。
"""
import json
import os
import sys
import time
from multiprocessing import resource_tracker, shared_memory

prefix = os.environ.get("SUKOSHI_TAKO_FRAMES", "/tkfake-")
input_path = os.environ.get("SUKOSHI_TAKO_INPUT", "")
width = int(os.environ.get("SUKOSHI_TAKO_WIDTH", "640"))
height = int(os.environ.get("SUKOSHI_TAKO_HEIGHT", "360"))
FPS = 30
FRAMES_IN_FLIGHT = 8
STAGES = [
    {"id": "burgerland-a", "name": "ミッドナイト・バーガーランド"},
    {"id": "sweets-a", "name": "スイーツ(偽)"},
]
parent = os.getppid()


def say(line):
    print(line, flush=True)


def read_input():
    """入力ファイルを読む。書きかけ(改行で終わらない)や形の違うものは None。"""
    try:
        with open(input_path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return None
    if not text.endswith("\n"):
        return None
    lines = text.split("\n")
    if len(lines) < 4 or not lines[1].startswith("P") or not lines[2].startswith("E"):
        return None
    first = lines[0].split()
    events = []
    for token in lines[2].split()[1:]:
        number, _, name = token.partition(":")
        if number.isdigit():
            events.append((int(number), name))
    return {
        "playing": bool(first) and first[0] == "1",
        "keys": first[1:],
        "pointer": lines[1].split()[1:],
        "events": events,
    }


def draw(frame, pointer):
    row = bytearray(width * 3)
    for x in range(width):
        shifted = (x + frame * 4) % width
        row[x * 3] = (shifted * 255) // width
        row[x * 3 + 1] = 96
        row[x * 3 + 2] = 255 - (shifted * 255) // width
    pixels = bytearray(row * height)
    # マウスの位置に白い四角を出す(割合 → 画素)
    try:
        px = int(float(pointer[2]) * (width - 1))
        py = int(float(pointer[3]) * (height - 1))
    except (IndexError, ValueError):
        px, py = width // 2, height // 2
    for y in range(max(0, py - 6), min(height, py + 6)):
        left = max(0, px - 6)
        right = min(width, px + 6)
        pixels[(y * width + left) * 3:(y * width + right) * 3] = b"\xff" * ((right - left) * 3)
    return pixels


say("@stages " + json.dumps(STAGES, ensure_ascii=False))
say("@state menu")

state = "menu"
mode = None
handled = 0
names = []
frame = 0
last_hud = ""
while True:
    started = time.time()
    # Claude Code が先に終わったら、見えないまま動き続けない
    if os.getppid() != parent or os.getppid() == 1:
        sys.exit(0)
    current = read_input()
    if current is not None:
        for number, name in sorted(current["events"]):
            if number <= handled:
                continue
            handled = number
            if name in ("world_seek", "world_hide"):
                mode = name
            elif name == "confirm_stage" and mode:
                state = "seek" if mode == "world_seek" else "hide"
                say("@state loading")
                say("@state " + state)
            elif name in ("back_to_hub", "retry"):
                state = "menu"
                say("@state menu")
        if state in ("hide", "seek") and "return" in current["keys"]:
            state = "result" if state == "seek" else "published"
            say("@state " + state + " 偽エンジンの結果")
        if current["playing"] and state in ("hide", "seek"):
            name = f"{prefix}{frame}"
            pixels = draw(frame, current["pointer"])
            shm = shared_memory.SharedMemory(name=name.lstrip("/"), create=True, size=len(pixels))
            shm.buf[:len(pixels)] = pixels
            shm.close()
            # 終了時に Python が勝手に unlink しないようにする(読むのはターミナル)
            try:
                resource_tracker.unregister(shm._name, "shared_memory")
            except Exception:
                pass
            names.append(name.lstrip("/"))
            # 読まれなかった古いフレームは自分で消す
            if len(names) > FRAMES_IN_FLIGHT:
                old = names.pop(0)
                try:
                    stale = shared_memory.SharedMemory(name=old)
                    stale.close()
                    stale.unlink()
                except FileNotFoundError:
                    pass
            say(f"@frame {name} {width} {height}")
            frame += 1
            hud = "keys=" + ",".join(current["keys"]) + "; pointer=" + " ".join(current["pointer"])
            if hud != last_hud:
                last_hud = hud
                say("@hud " + hud)
    time.sleep(max(0.0, 1.0 / FPS - (time.time() - started)))
