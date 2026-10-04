import { describe, expect, test } from 'claude-code/testing'

import {
  canShowPixels,
  checksumMatches,
  idlePointer,
  initialState,
  inputFileText,
  inputPathFor,
  newEngineSession,
  parseEngineLine,
  parseEngineManifest,
  pushEvent,
  reduce,
  releasedPointer,
  resolveEngineOverride,
  rowsFor,
  splitLines,
  stageButtonProps,
} from '../hooks/logic.js'

type Action = Parameters<typeof reduce>[1]

// いくつかの操作を順に流し、最後の状態と、最後の 1 歩の副作用を返す
function run(actions: Action[], from = { ...initialState(), isOn: true }) {
  let state = from
  let effects: string[] = []
  for (const action of actions) {
    const stepped = reduce(state, action)
    state = stepped.state
    effects = stepped.effects
  }
  return { state, effects }
}

describe('出し入れ', () => {
  test('オンのとき、作業が始まると待ち時間のタイマーを掛ける', () => {
    const { state, effects } = run([{ type: 'turnStart' }])
    expect(state.phase).toBe('waiting')
    expect(effects).toEqual(['armDropIn'])
  })

  test('オフのときは何もしない', () => {
    const { state, effects } = run([{ type: 'turnStart' }], initialState())
    expect(state.phase).toBe('idle')
    expect(effects).toEqual([])
  })

  test('待ち時間が過ぎたら開き、置けたら遊ぶ', () => {
    const due = run([{ type: 'turnStart' }, { type: 'dropInDue' }])
    expect(due.effects).toEqual(['open'])
    const placed = run([{ type: 'opened', isPlaced: true }], due.state)
    expect(placed.state.phase).toBe('playing')
  })

  test('狭くて置けなかったら、帯で誘う', () => {
    const { state } = run([{ type: 'turnStart' }, { type: 'dropInDue' }, { type: 'opened', isPlaced: false }])
    expect(state.phase).toBe('offered')
  })

  test('作業が終わると 3 秒数えてから閉じる', () => {
    const playing = run([{ type: 'turnStart' }, { type: 'dropInDue' }, { type: 'opened', isPlaced: true }])
    const done = run([{ type: 'turnComplete', isAborted: false }], playing.state)
    expect(done.state.phase).toBe('countdown')
    expect(done.state.countdown).toBe(3)
    expect(done.effects).toEqual(['startCountdown', 'redraw'])
    const two = run([{ type: 'countdownTick' }, { type: 'countdownTick' }], done.state)
    expect(two.state.phase).toBe('countdown')
    const closed = run([{ type: 'countdownTick' }], two.state)
    expect(closed.state.phase).toBe('idle')
    expect(closed.effects).toEqual(['cancelTimer', 'close'])
  })

  test('中断されたら数えずにすぐ閉じる', () => {
    const playing = run([{ type: 'turnStart' }, { type: 'dropInDue' }, { type: 'opened', isPlaced: true }])
    const aborted = run([{ type: 'turnComplete', isAborted: true }], playing.state)
    expect(aborted.state.phase).toBe('idle')
    expect(aborted.effects).toEqual(['cancelTimer', 'close'])
  })

  test('数えている間に次の作業が始まったら、そのまま遊ぶ', () => {
    const counting = run([
      { type: 'turnStart' },
      { type: 'dropInDue' },
      { type: 'opened', isPlaced: true },
      { type: 'turnComplete', isAborted: false },
    ])
    const again = run([{ type: 'turnStart' }], counting.state)
    expect(again.state.phase).toBe('playing')
    expect(again.effects).toEqual(['cancelTimer', 'redraw'])
  })

  test('Claude が確認を出したら即座に閉じ、答えた後にまた入る', () => {
    const playing = run([{ type: 'turnStart' }, { type: 'dropInDue' }, { type: 'opened', isPlaced: true }])
    const asked = run([{ type: 'needsYou' }], playing.state)
    expect(asked.state.phase).toBe('idle')
    expect(asked.effects).toEqual(['cancelTimer', 'close'])
    const resumed = run([{ type: 'toolRan' }], asked.state)
    expect(resumed.state.phase).toBe('waiting')
    expect(resumed.effects).toEqual(['armDropIn'])
  })

  test('待っている間に確認が出たら、タイマーを止める', () => {
    const asked = run([{ type: 'turnStart' }, { type: 'needsYou' }])
    expect(asked.state.phase).toBe('idle')
    expect(asked.effects).toEqual(['cancelTimer', 'redraw'])
  })

  test('自分で閉じたら、その作業の間は開かない', () => {
    const closed = run([
      { type: 'turnStart' },
      { type: 'dropInDue' },
      { type: 'opened', isPlaced: true },
      { type: 'paneClosed', byPerson: true },
    ])
    expect(closed.state.isDismissed).toBe(true)
    const after = run([{ type: 'toolRan' }], closed.state)
    expect(after.state.phase).toBe('idle')
    const nextTurn = run([{ type: 'turnComplete', isAborted: false }, { type: 'turnStart' }], after.state)
    expect(nextTurn.state.phase).toBe('waiting')
  })

  test('オフにすると、遊んでいる最中でも閉じる', () => {
    const playing = run([{ type: 'turnStart' }, { type: 'dropInDue' }, { type: 'opened', isPlaced: true }])
    const off = run([{ type: 'setOn', isOn: false }], playing.state)
    expect(off.state.phase).toBe('idle')
    expect(off.effects).toEqual(['cancelTimer', 'close'])
  })
})

describe('絵の大きさ', () => {
  test('16:9 の絵は、列数の約 0.28 倍の行数になる', () => {
    expect(rowsFor(80, 640, 360)).toBe(23)
    expect(rowsFor(255, 640, 360)).toBe(72)
  })

  test('列数が 0 でも 1 行は確保する', () => {
    expect(rowsFor(0, 640, 360)).toBe(1)
  })
})

describe('入力ファイル', () => {
  test('3 行で、必ず改行で終わる', () => {
    const text = inputFileText({
      isPlaying: true,
      keys: ['w', 'd', 'up'],
      pointer: { ...idlePointer(), isLeftDown: true, x: 0.5, y: 0.25, leftDowns: 3, leftUps: 2 },
      events: [{ id: 12, name: 'world_seek' }, { id: 13, name: 'stage:burgerland-a' }],
    })
    expect(text).toBe('1 d up w\nP 1 0 0.5000 0.2500 3 2 0 0\nE 12:world_seek 13:stage:burgerland-a\n')
  })

  test('遊んでいない間は、キーもボタンも押されていない扱いにする', () => {
    const text = inputFileText({
      isPlaying: false,
      keys: ['w'],
      pointer: { ...idlePointer(), isLeftDown: true, leftDowns: 1 },
      events: [],
    })
    expect(text).toBe('0\nP 0 0 0.0000 0.0000 1 0 0 0\nE\n')
  })

  test('範囲外の位置は端に寄せる', () => {
    const text = inputFileText({ isPlaying: true, keys: [], pointer: { ...idlePointer(), x: 1.5, y: -0.2 }, events: [] })
    expect(text.split('\n')[1]).toBe('P 0 0 1.0000 0.0000 0 0 0 0')
  })

  test('単発の操作は新しい 8 件だけ残す', () => {
    let events: { id: number; name: string }[] = []
    for (let id = 1; id <= 10; id += 1) events = pushEvent(events, id, 'e' + id)
    expect(events.length).toBe(8)
    expect(events[0].id).toBe(3)
    expect(events[7].id).toBe(10)
  })
})

describe('エンジンの出力', () => {
  test('かたまりで届いた出力を行に分け、途中の行は持ち越す', () => {
    const first = splitLines('', '@frame /tk1-0 640 360\n@fra')
    expect(first.lines).toEqual(['@frame /tk1-0 640 360'])
    expect(first.pending).toBe('@fra')
    const second = splitLines(first.pending, 'me /tk1-1 640 360\n')
    expect(second.lines).toEqual(['@frame /tk1-1 640 360'])
    expect(second.pending).toBe('')
  })

  test('各行を読み分ける', () => {
    expect(parseEngineLine('@frame /tk1-7 640 360')).toEqual({ type: 'frame', name: '/tk1-7' })
    expect(parseEngineLine('@hud color=#ff0000; brush=round')).toEqual({ type: 'hud', text: 'color=#ff0000; brush=round' })
    expect(parseEngineLine('@state seek')).toEqual({ type: 'state', state: 'seek', detail: '' })
    expect(parseEngineLine('@state result 3 人中 2 人を見つけた')).toEqual({
      type: 'state',
      state: 'result',
      detail: '3 人中 2 人を見つけた',
    })
    expect(parseEngineLine('@fatal hero.glb not found')).toEqual({ type: 'fatal', reason: 'hero.glb not found' })
  })

  test('コース一覧は JSON で受け取り、形の違うものは捨てる', () => {
    const parsed = parseEngineLine('@stages [{"id":"burgerland-a","name":"バーガー \\"ランド\\""},{"id":3}]')
    expect(parsed).toEqual({ type: 'stages', stages: [{ id: 'burgerland-a', name: 'バーガー "ランド"' }] })
    expect(parseEngineLine('@stages not-json')).toBe(null)
  })

  test('約束に無い行は無視する', () => {
    expect(parseEngineLine('some log line')).toBe(null)
    expect(parseEngineLine('@unknown x')).toBe(null)
    expect(parseEngineLine('@frame')).toBe(null)
  })
})

describe('エンジンを起動し直したとき', () => {
  test('前のエンジンの時代に溜まった単発操作は、新しいエンジンに渡さない', () => {
    // 新しいエンジンは「処理済みの番号」を 0 から数える。古い「探す・コース・決定」を渡すと、
    // 何も選んでいないのに前回のコースが始まってしまう。
    const fresh = newEngineSession()
    expect(fresh.events).toEqual([])
    expect(fresh.keys).toEqual([])
    expect(fresh.pointer).toEqual(idlePointer())
    expect(inputFileText({ isPlaying: false, ...fresh })).toBe('0\nP 0 0 0.0000 0.0000 0 0 0 0\nE\n')
  })
})

describe('入力ファイルの置き場所', () => {
  test('ユーザーごとの一時フォルダに置く(ほかのユーザーが書ける /tmp には置かない)', () => {
    expect(inputPathFor('/var/folders/ab/xyz/T/', 'ab12')).toBe('/var/folders/ab/xyz/T/sukoshi-tako-ab12.input')
    expect(inputPathFor('/var/folders/ab/xyz/T', 'ab12')).toBe('/var/folders/ab/xyz/T/sukoshi-tako-ab12.input')
  })

  test('一時フォルダが分からない・絶対パスでないときだけ /tmp に戻す', () => {
    expect(inputPathFor(undefined, 'ab12')).toBe('/tmp/sukoshi-tako-ab12.input')
    expect(inputPathFor('', 'ab12')).toBe('/tmp/sukoshi-tako-ab12.input')
    expect(inputPathFor('relative/dir', 'ab12')).toBe('/tmp/sukoshi-tako-ab12.input')
  })
})

describe('開発用のゲーム本体の指定', () => {
  test('SUKOSHI_TAKO_DEV=1 が無ければ、指定があっても無視する(SHA-256 の照合を迂回させない)', () => {
    expect(resolveEngineOverride('/opt/dev/ChameleonPane', undefined)).toBe(null)
    expect(resolveEngineOverride('/opt/dev/ChameleonPane', '0')).toBe(null)
    expect(resolveEngineOverride('fake', '')).toBe(null)
  })

  test('許可があれば、絶対パスと fake だけ受け付ける', () => {
    expect(resolveEngineOverride('/opt/dev/ChameleonPane', '1')).toBe('/opt/dev/ChameleonPane')
    expect(resolveEngineOverride('fake', '1')).toBe('fake')
    expect(resolveEngineOverride('./evil', '1')).toBe(null)
    expect(resolveEngineOverride('evil', '1')).toBe(null)
    expect(resolveEngineOverride('', '1')).toBe(null)
    expect(resolveEngineOverride(undefined, '1')).toBe(null)
  })
})

describe('ゲームの場面を離れるとき', () => {
  test('押していたボタンは、離した回数を 1 つ足して離した扱いにする', () => {
    // ペインの入力部品が消えると離す操作が届かない。そのままだとゲームは「押しっぱなし」を続ける。
    const held = { ...idlePointer(), isLeftDown: true, isRightDown: true, x: 0.4, y: 0.6, leftDowns: 3, leftUps: 2, rightDowns: 1, rightUps: 0 }
    expect(releasedPointer(held)).toEqual({
      isLeftDown: false, isRightDown: false, x: 0.4, y: 0.6, leftDowns: 3, leftUps: 3, rightDowns: 1, rightUps: 1,
    })
  })

  test('押していなければ、そのまま', () => {
    const idle = { ...idlePointer(), x: 0.2, y: 0.9, leftDowns: 4, leftUps: 4 }
    expect(releasedPointer(idle)).toEqual(idle)
  })
})

describe('ゲーム本体の取得', () => {
  const sha = 'a'.repeat(64)

  test('engine.json を読む', () => {
    const manifest = parseEngineManifest(
      JSON.stringify({ version: '0.1.0', url: 'https://example.invalid/engine.tar.gz', sha256: sha }),
    )
    expect(manifest).toEqual({ version: '0.1.0', url: 'https://example.invalid/engine.tar.gz', sha256: sha })
  })

  test('形の違う engine.json は使わない', () => {
    expect(parseEngineManifest('not json')).toBe(null)
    expect(parseEngineManifest(JSON.stringify({ version: '0.1.0', url: 'https://x.invalid/a' }))).toBe(null)
    expect(parseEngineManifest(JSON.stringify({ version: '0.1.0', url: 'https://x.invalid/a', sha256: 'short' }))).toBe(null)
    expect(parseEngineManifest(JSON.stringify({ version: '0.1.0', url: 'ftp://x.invalid/a', sha256: sha }))).toBe(null)
  })

  test('shasum の出力と engine.json の値が一致したときだけ通す', () => {
    expect(checksumMatches(sha + '  /tmp/engine.tar.gz\n', sha)).toBe(true)
    expect(checksumMatches(sha.toUpperCase() + '  /tmp/engine.tar.gz\n', sha)).toBe(true)
    expect(checksumMatches('b'.repeat(64) + '  /tmp/engine.tar.gz\n', sha)).toBe(false)
    expect(checksumMatches('', sha)).toBe(false)
    expect(checksumMatches(sha.slice(0, 63) + '  /tmp/engine.tar.gz\n', sha)).toBe(false)
  })
})

describe('コース選択のボタン', () => {
  const stages = [
    { id: 'burgerland-a', name: 'バーガーランド' },
    { id: 'sweets-a', name: 'スイーツガーデン' },
    { id: 'station-a', name: 'ステーション' },
  ]

  test('先頭だけ autoFocus を持ち、ほかは付けない(false を渡すと描画が拒否される)', () => {
    const buttons = stageButtonProps(stages)
    expect(buttons[0].autoFocus).toBe(true)
    expect('autoFocus' in buttons[1]).toBe(false)
    expect('autoFocus' in buttons[2]).toBe(false)
  })

  test('キーはコースごとに別で、数字のホットキーが 1 から付く', () => {
    const buttons = stageButtonProps(stages)
    expect(buttons.map((b) => b.key)).toEqual(['stage-burgerland-a', 'stage-sweets-a', 'stage-station-a'])
    expect(buttons.map((b) => b.hotkey)).toEqual(['1', '2', '3'])
    expect(buttons.map((b) => b.label)).toEqual(['バーガーランド', 'スイーツガーデン', 'ステーション'])
  })

  test('ホットキーは 1 桁なので、9 件までにする', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: 's' + i, name: 'コース' + i }))
    expect(stageButtonProps(many).length).toBe(9)
  })
})

describe('ターミナルの見分け', () => {
  test('Ghostty と kitty だけ絵が出せる', () => {
    expect(canShowPixels({ termProgram: 'ghostty', term: 'xterm-ghostty', kittyWindowId: undefined })).toBe(true)
    expect(canShowPixels({ termProgram: undefined, term: 'xterm-kitty', kittyWindowId: '1' })).toBe(true)
    expect(canShowPixels({ termProgram: 'iTerm.app', term: 'xterm-256color', kittyWindowId: undefined })).toBe(false)
    expect(canShowPixels({ termProgram: undefined, term: undefined, kittyWindowId: undefined })).toBe(false)
  })
})
