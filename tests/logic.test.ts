import { describe, expect, test } from 'claude-code/testing'

import {
  canShowPixels,
  checksumMatches,
  commandAction,
  commandNames,
  engineSize,
  imageCells,
  isStartStillWanted,
  removeFileArgv,
  paneOpenArgs,
  engineEntryFor,
  enginePathFor,
  fetchPlan,
  idlePointer,
  initialState,
  isEngineUp,
  inputFileText,
  inputPathFor,
  isAbsolutePath,
  isPlayingPhase,
  NEEDS_LOCAL_SESSION,
  NEEDS_OTHER_ENV,
  NEEDS_TERMINAL,
  newEngineSession,
  PANE_HEIGHT,
  PANE_WIDTH,
  packPathFor,
  paneView,
  parseEngineAssets,
  parseEngineLine,
  playCommandPlan,
  playOutcomeText,
  PLAY_STARTING_IN_WINDOW,
  parseEngineManifest,
  platformKey,
  playMode,
  readableHud,
  pushEvent,
  reduce,
  releasedPointer,
  resolveEngineOverride,
  devMarkerPath,
  rowsFor,
  splitLines,
  surfaceOrGuess,
  stageButtonProps,
  unavailableText,
  WINDOW_HELP,
  WINDOW_NOTE,
  WINDOW_UNAVAILABLE,
  WINDOW_UNAVAILABLE_LINUX,
  WINDOW_UNAVAILABLE_WINDOWS,
  classifyEngineEnd,
  devEngineRequest,
  engineEndAction,
  engineEndNotice,
  failureNotice,
  outputTail,
  engineEnv,
  launchRequest,
  noBuildText,
  resolveEngineAsset,
  windowUnavailableText,
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

describe('出し入れ(ウィンドウ方式)', () => {
  const windowStart = { ...initialState(), isOn: true, mode: 'window' }
  const playing = [
    { type: 'turnStart' },
    { type: 'openedByPerson' },
  ] as const

  test('作業が始まっても、自動では開かない', () => {
    const { state, effects } = run([{ type: 'turnStart' }], windowStart)
    expect(state.phase).toBe('idle')
    expect(state.isTurnRunning).toBe(true)
    expect(effects).toEqual([])
  })

  test('/tako:play やペインのボタンで開くと遊ぶ', () => {
    const opened = run([...playing], windowStart)
    expect(opened.state.phase).toBe('playing')
  })

  test('作業が終わっても、ペインは閉じず、遊んでいるかを 0 にする', () => {
    const start = run([...playing], windowStart)
    const done = run([{ type: 'turnComplete', isAborted: false }], start.state)
    expect(done.state.phase).toBe('paused')
    // close も startCountdown も出さない = ペインを閉じない・本体を止めない
    expect(done.effects).toEqual(['redraw'])
    expect(isPlayingPhase(done.state.phase)).toBe(false)
  })

  test('中断されても、閉じずに止める', () => {
    const start = run([...playing], windowStart)
    const aborted = run([{ type: 'turnComplete', isAborted: true }], start.state)
    expect(aborted.state.phase).toBe('paused')
    expect(aborted.effects).toEqual(['redraw'])
  })

  test('確認が出たときも、閉じずに止める', () => {
    const start = run([...playing], windowStart)
    const asked = run([{ type: 'needsYou' }], start.state)
    expect(asked.state.phase).toBe('paused')
    expect(asked.effects).toEqual(['redraw'])
  })

  test('止まっている間に Claude が続きを始めたら、また遊ぶ', () => {
    const paused = run([...playing, { type: 'turnComplete', isAborted: false }], windowStart)
    const again = run([{ type: 'turnStart' }], paused.state)
    expect(again.state.phase).toBe('playing')
    expect(again.effects).toEqual(['redraw'])
    const afterTool = run([{ type: 'toolRan' }], paused.state)
    expect(afterTool.state.phase).toBe('playing')
  })

  test('オフにすると、止まっていても閉じる', () => {
    const paused = run([...playing, { type: 'turnComplete', isAborted: false }], windowStart)
    const off = run([{ type: 'setOn', isOn: false }], paused.state)
    expect(off.state.phase).toBe('idle')
    expect(off.effects).toEqual(['cancelTimer', 'close'])
  })

  test('方式は状態機械が持つ。既定はペイン方式のまま', () => {
    expect(initialState().mode).toBe('pane')
    const changed = run([{ type: 'setMode', mode: 'window' }])
    expect(changed.state.mode).toBe('window')
    expect(changed.state.phase).toBe('idle')
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
    expect(resolveEngineOverride('/opt/dev/ChameleonPane', '1', 'darwin', true)).toBe('/opt/dev/ChameleonPane')
    expect(resolveEngineOverride('fake', '1', 'darwin', true)).toBe('fake')
    expect(resolveEngineOverride('./evil', '1', 'darwin', true)).toBe(null)
    expect(resolveEngineOverride('evil', '1', 'darwin', true)).toBe(null)
    expect(resolveEngineOverride('', '1', 'darwin', true)).toBe(null)
    expect(resolveEngineOverride(undefined, '1', 'darwin', true)).toBe(null)
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

describe('OS の見分け', () => {
  const none = { envOS: undefined, unameS: undefined, unameM: undefined, processorArchitecture: undefined }

  test('Windows は環境変数 OS を先に見て、CPU が AMD64 のときだけ', () => {
    const win = { ...none, envOS: 'Windows_NT' }
    expect(platformKey({ ...win, processorArchitecture: 'AMD64' })).toBe('win32-x64')
    expect(platformKey({ ...win, processorArchitecture: 'amd64' })).toBe('win32-x64')
    expect(platformKey({ ...win, processorArchitecture: 'ARM64' })).toBe(null)
    expect(platformKey({ ...win, processorArchitecture: undefined })).toBe(null)
    expect(platformKey({ ...win, unameS: 'Darwin', processorArchitecture: 'AMD64' })).toBe('win32-x64')
  })

  test('Darwin は配布物がユニバーサルなので、CPU を問わない', () => {
    expect(platformKey({ ...none, unameS: 'Darwin', unameM: 'arm64' })).toBe('darwin')
    expect(platformKey({ ...none, unameS: ' Darwin \n', unameM: 'x86_64', processorArchitecture: 'ARM64' })).toBe('darwin')
  })

  test('Linux は x86_64 か amd64 のときだけ', () => {
    expect(platformKey({ ...none, unameS: 'Linux', unameM: 'x86_64' })).toBe('linux-x64')
    expect(platformKey({ ...none, unameS: 'Linux', unameM: 'amd64' })).toBe('linux-x64')
    expect(platformKey({ ...none, unameS: 'Linux', unameM: 'aarch64' })).toBe(null)
  })

  test('知らない OS や、uname が無いときは null', () => {
    expect(platformKey(none)).toBe(null)
    expect(platformKey({ ...none, unameS: 'FreeBSD', unameM: 'amd64' })).toBe(null)
  })
})

describe('遊び方の判定', () => {
  // 表示先 4 種 × hasPixels 2 種 × platform 4 種の全 32 通りを固定する。
  // Windows / Linux は、ターミナルでもデスクトップでも本体のウィンドウ(新しい本体は絵をペインに出さない)。
  // 画素が出るかどうかは Mac のターミナルの話で、Windows / Linux の答えには効かない
  const table: [string, boolean, string | null, 'pane' | 'window' | 'none'][] = [
    ['terminal', true, 'darwin', 'pane'],
    // 絵を出せないターミナル(Terminal.app、iTerm2 など)でも、別ウィンドウで遊べる
    ['terminal', false, 'darwin', 'window'],
    ['desktop', true, 'darwin', 'window'],
    ['desktop', false, 'darwin', 'window'],
    ['mobile', true, 'darwin', 'none'],
    ['mobile', false, 'darwin', 'none'],
    ['vscode', true, 'darwin', 'none'],
    ['vscode', false, 'darwin', 'none'],
    ['terminal', true, 'win32-x64', 'window'],
    ['terminal', false, 'win32-x64', 'window'],
    ['desktop', true, 'win32-x64', 'window'],
    ['desktop', false, 'win32-x64', 'window'],
    ['mobile', true, 'win32-x64', 'none'],
    ['mobile', false, 'win32-x64', 'none'],
    ['vscode', true, 'win32-x64', 'none'],
    ['vscode', false, 'win32-x64', 'none'],
    ['terminal', true, 'linux-x64', 'window'],
    ['terminal', false, 'linux-x64', 'window'],
    ['desktop', true, 'linux-x64', 'window'],
    ['desktop', false, 'linux-x64', 'window'],
    ['mobile', true, 'linux-x64', 'none'],
    ['mobile', false, 'linux-x64', 'none'],
    ['vscode', true, 'linux-x64', 'none'],
    ['vscode', false, 'linux-x64', 'none'],
    ['terminal', true, null, 'none'],
    ['terminal', false, null, 'none'],
    ['desktop', true, null, 'none'],
    ['desktop', false, null, 'none'],
    ['mobile', true, null, 'none'],
    ['mobile', false, null, 'none'],
    ['vscode', true, null, 'none'],
    ['vscode', false, null, 'none'],
  ]

  test('表の全 32 通り', () => {
    expect(table.length).toBe(32)
    for (const [surface, hasPixels, platform, expected] of table) {
      expect(playMode({ surface, hasPixels, platform })).toBe(expected)
    }
  })
})

describe('ペインに描くもの(paneView)', () => {
  const base = {
    platform: 'darwin',
    scene: 'starting',
    phase: 'idle',
    countdown: 0,
    menuMode: null,
    stages: [],
    sceneDetail: '',
    failure: null,
    downloadStatus: null,
    hud: '',
    isDebug: false,
    keys: [],
    lastKey: '',
    hasFrame: false,
    columns: 80,
  }

  // 方式 3 種 × 場面 9 種の全 27 通りを固定する(表示先は playMode の 32 通りで方式になる)
  test('方式と場面の全組み合わせ', () => {
    const scenes = ['starting', 'loading', 'menu', 'hide', 'seek', 'published', 'result', 'error', 'unknown']
    for (const mode of ['pane', 'window', 'none'] as const) {
      for (const scene of scenes) {
        const view = paneView({ ...base, scene, hasFrame: true }, mode)
        let expected = 'error'
        if (mode === 'none') expected = 'unavailable'
        else if (scene === 'starting' || scene === 'loading') expected = 'message'
        else if (scene === 'menu') expected = 'menu'
        else if (scene === 'hide' || scene === 'seek') expected = mode === 'window' ? 'windowGame' : 'game'
        else if (scene === 'published' || scene === 'result') expected = 'outcome'
        expect(view.kind).toBe(expected)
      }
    }
  })

  test('ウィンドウ方式の記述には、絵と入力の要素に当たるものが入らない', () => {
    const scenes = ['starting', 'loading', 'menu', 'hide', 'seek', 'published', 'result', 'error']
    for (const scene of scenes) {
      const text = JSON.stringify(paneView({ ...base, scene, hasFrame: true }, 'window')).toLowerCase()
      expect(text).not.toContain('image')
      expect(text).not.toContain('client')
      expect(text).not.toContain('aboveprompt')
    }
  })

  test('ペイン方式のゲーム画面だけが、絵と入力の場所を持つ', () => {
    const pane = paneView({ ...base, scene: 'seek', hasFrame: true, columns: 80 }, 'pane')
    expect(pane.kind).toBe('game')
    expect(pane.image).toEqual({ columns: 80, rows: rowsFor(80, PANE_WIDTH, PANE_HEIGHT) })
    const window = paneView({ ...base, scene: 'seek', hasFrame: true }, 'window')
    expect(window.image).toBe(undefined)
  })

  test('ゲームの絵がまだ来ていないときは、読み込み中', () => {
    expect(paneView({ ...base, scene: 'seek', hasFrame: false }, 'pane')).toEqual({
      kind: 'message',
      text: '読み込んでいます…',
    })
  })

  test('ウィンドウ方式のゲーム画面は、案内とボタンだけ', () => {
    const view = paneView({ ...base, scene: 'seek', hud: 'のこり 2', hasFrame: true }, 'window')
    expect(view.kind).toBe('windowGame')
    expect(view.note).toBe(WINDOW_NOTE)
    expect(view.hud).toBe('のこり 2')
    expect(view.help).toBe(WINDOW_HELP)
    // 操作の説明は、ウィンドウ方式でもペインに出す(ゲームのウィンドウには文字が無い)
    expect(view.keys.join(' ')).toContain('さがし終わり')
    expect(view.buttons.map((b: { label: string }) => b.label)).toEqual(['メニューへ', 'やめる'])
    expect(view.buttons.map((b: { action: string }) => b.action)).toEqual(['event', 'close'])
    expect(view.buttons[0].event).toBe('back_to_hub')
    expect(view.buttons[0].autoFocus).toBe(true)
  })

  test('メニューは今までと同じボタン', () => {
    const menu = paneView({ ...base, scene: 'menu' }, 'pane')
    expect(menu.kind).toBe('menu')
    expect(menu.title).toBe('全世界モード')
    expect(menu.options.map((o: { label: string }) => o.label)).toEqual(['誰かを探しに行く', '世界に隠れる'])
    const stages = [{ id: 'burgerland-a', name: 'バーガーランド' }]
    const stageMenu = paneView({ ...base, scene: 'menu', menuMode: 'world_seek', stages }, 'pane')
    expect(stageMenu.title).toBe('どのコースを探しますか')
    expect(stageMenu.options.map((o: { label: string }) => o.label)).toEqual(['バーガーランド', '戻る'])
    expect(stageMenu.options[0].action).toBe('stage')
    expect(stageMenu.options[0].stageId).toBe('burgerland-a')
    expect(stageMenu.options[0].autoFocus).toBe(true)
  })

  test('結果とエラーも、今までのボタン', () => {
    const result = paneView({ ...base, scene: 'result', sceneDetail: 'みつけた 1 · みつけられなかった 0' }, 'pane')
    expect(result.kind).toBe('outcome')
    expect(result.title).toBe('結果')
    expect(result.detail).toBe('みつけた 1 · みつけられなかった 0')
    expect(result.button.label).toBe('ハブへ戻る')
    const error = paneView({ ...base, scene: 'error', failure: '起動できません' }, 'pane')
    expect(error.kind).toBe('error')
    expect(error.text).toBe('起動できません')
    expect(error.guidance).toBe(null)
  })

  test('ウィンドウ方式で開けなかったときだけ、Local のセッションの案内を出す', () => {
    const view = paneView({ ...base, scene: 'error', failure: '起動できません' }, 'window')
    expect(view.guidance).toBe(WINDOW_UNAVAILABLE)
  })

  test('表示先ごとに、方式と描けるものが揃っている', () => {
    // 表示先 → playMode の方式 → paneView の記述、の全組み合わせ(Mac・画素あり)
    const table: [string, 'pane' | 'window' | 'none', string][] = [
      ['terminal', 'pane', 'game'],
      ['desktop', 'window', 'windowGame'],
      ['mobile', 'none', 'unavailable'],
      ['vscode', 'none', 'unavailable'],
    ]
    for (const [surface, mode, kind] of table) {
      expect(playMode({ surface, hasPixels: true, platform: 'darwin' })).toBe(mode)
      expect(paneView({ ...base, scene: 'seek', hasFrame: true }, mode).kind).toBe(kind)
    }
  })

  test('遊べないときは、OS に合った案内文', () => {
    expect(paneView({ ...base, platform: 'darwin' }, 'none').text).toBe(NEEDS_TERMINAL)
    expect(paneView({ ...base, platform: 'win32-x64' }, 'none').text).toBe(NEEDS_LOCAL_SESSION)
    expect(paneView({ ...base, platform: 'linux-x64' }, 'none').text).toBe(NEEDS_LOCAL_SESSION)
    expect(paneView({ ...base, platform: null }, 'none').text).toBe(NEEDS_OTHER_ENV)
    expect(unavailableText('darwin')).toBe(NEEDS_TERMINAL)
  })

  test('ペイン方式のゲーム画面には、場面に合った操作の説明が入る', () => {
    const seek = paneView({ ...base, scene: 'seek', hasFrame: true }, 'pane')
    expect(seek.status).toBe(null)
    expect(seek.help.join(' ')).toContain('さがし終わり')
    const hide = paneView({ ...base, scene: 'hide', hasFrame: true }, 'pane')
    expect(hide.help.join(' ')).toContain('ここに隠れる')
  })

  test('操作の説明は短い行に分ける(1 行に詰めると狭いペインで折り返して絵から離れる)', () => {
    for (const scene of ['seek', 'hide']) {
      const view = paneView({ ...base, scene, hasFrame: true }, 'pane')
      expect(view.help.length).toBeGreaterThanOrEqual(2)
      for (const line of view.help) expect(line.length).toBeLessThanOrEqual(60)
    }
  })

  test('絵は、説明と HUD が下に収まる高さまでにする', () => {
    const view = paneView({ ...base, scene: 'seek', hasFrame: true, columns: 120, rows: 30 }, 'pane')
    expect(view.image.rows + view.help.length + 1).toBeLessThanOrEqual(30)
  })

  test('数えている間は残りを大きく出す', () => {
    const view = paneView({ ...base, scene: 'seek', hasFrame: true, phase: 'countdown', countdown: 2 }, 'pane')
    expect(view.status).toEqual({ text: 'Claude の作業が終わりました · あと 2', style: 'bold' })
  })
})

describe('配布物の一覧', () => {
  const sha = 'a'.repeat(64)
  const oldShape = JSON.stringify({
    version: '0.0.2',
    url: 'https://example.invalid/macos.tar.gz',
    sha256: sha,
  })
  const newShape = JSON.stringify({
    version: '0.1.0',
    url: 'https://example.invalid/macos.tar.gz',
    sha256: sha,
    assets: {
      darwin: { url: 'https://example.invalid/macos.tar.gz', sha256: sha, entry: 'sukoshi-tako-engine/ChameleonPane' },
      'win32-x64': {
        url: 'https://example.invalid/win32.tar.gz',
        sha256: 'b'.repeat(64),
        entry: 'sukoshi-tako-engine/ChameleonPane.exe',
      },
      'linux-x64': {
        url: 'file:///srv/sukoshi-tako.tar.gz',
        sha256: 'c'.repeat(64),
        entry: 'sukoshi-tako-engine/chameleon-pane',
      },
    },
  })

  test('今の engine.json の形(最上位だけ)は darwin として読む', () => {
    expect(parseEngineAssets(oldShape)).toEqual({
      darwin: { url: 'https://example.invalid/macos.tar.gz', sha256: sha, entry: 'sukoshi-tako-engine/ChameleonPane' },
    })
  })

  test('新しい形は OS ごとの一覧を読む', () => {
    expect(parseEngineAssets(newShape)).toEqual({
      darwin: { url: 'https://example.invalid/macos.tar.gz', sha256: sha, entry: 'sukoshi-tako-engine/ChameleonPane' },
      'win32-x64': {
        url: 'https://example.invalid/win32.tar.gz',
        sha256: 'b'.repeat(64),
        entry: 'sukoshi-tako-engine/ChameleonPane.exe',
      },
      'linux-x64': {
        url: 'file:///srv/sukoshi-tako.tar.gz',
        sha256: 'c'.repeat(64),
        entry: 'sukoshi-tako-engine/chameleon-pane',
      },
    })
  })

  test('新しい形を、古いプラグインの parseEngineManifest も今までどおり読める(古いプラグインとの互換)', () => {
    expect(parseEngineManifest(newShape)).toEqual({
      version: '0.1.0',
      url: 'https://example.invalid/macos.tar.gz',
      sha256: sha,
    })
  })

  test('darwin が採れなければ、最上位の url / sha256 から補う', () => {
    const noDarwin = JSON.stringify({
      version: '0.1.0',
      url: 'https://example.invalid/macos.tar.gz',
      sha256: sha,
      assets: {
        'win32-x64': { url: 'https://example.invalid/win32.tar.gz', sha256: 'b'.repeat(64), entry: 'engine/ChameleonPane.exe' },
      },
    })
    const parsed = parseEngineAssets(noDarwin)
    expect(parsed?.darwin).toEqual({
      url: 'https://example.invalid/macos.tar.gz',
      sha256: sha,
      entry: 'sukoshi-tako-engine/ChameleonPane',
    })
    expect(parsed?.['win32-x64']?.entry).toBe('engine/ChameleonPane.exe')
  })

  test('形の違うものは null', () => {
    expect(parseEngineAssets('not json')).toBe(null)
    expect(parseEngineAssets(JSON.stringify({ version: '0.1.0', url: 'ftp://x.invalid/a', sha256: sha }))).toBe(null)
  })

  test('条件を満たさない項目は捨て、知らない OS の行は見ない', () => {
    const text = JSON.stringify({
      version: '0.1.0',
      url: 'https://example.invalid/macos.tar.gz',
      sha256: sha,
      assets: {
        darwin: { url: 'http://example.invalid/plain.tar.gz', sha256: 'b'.repeat(64), entry: 'engine/ChameleonPane' },
        'win32-x64': { url: 'https://example.invalid/win32.tar.gz', sha256: 'SHORT', entry: 'engine/ChameleonPane.exe' },
        'linux-x64': { url: 'https://example.invalid/linux.tar.gz', sha256: 'c'.repeat(64), entry: 'engine/chameleon-pane' },
        'freebsd-x64': { url: 'https://example.invalid/freebsd.tar.gz', sha256: 'd'.repeat(64), entry: 'engine/pane' },
      },
    })
    const parsed = parseEngineAssets(text)
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['darwin', 'linux-x64'])
    expect(parsed?.darwin.url).toBe('https://example.invalid/macos.tar.gz')
    expect(parsed?.['linux-x64']?.entry).toBe('engine/chameleon-pane')
  })

  test('entry は配布物の中の相対パスだけを受ける', () => {
    const entries = [
      '/engine/ChameleonPane',
      '../engine/ChameleonPane',
      'engine/../../ChameleonPane',
      'engine\\ChameleonPane',
      'C:/engine/ChameleonPane',
      'engine:ChameleonPane',
      '',
    ]
    for (const entry of entries) {
      const text = JSON.stringify({
        version: '0.1.0',
        url: 'https://example.invalid/macos.tar.gz',
        sha256: sha,
        assets: { 'linux-x64': { url: 'https://example.invalid/linux.tar.gz', sha256: 'c'.repeat(64), entry } },
      })
      expect(parseEngineAssets(text)?.['linux-x64']).toBe(undefined)
    }
    const good = JSON.stringify({
      version: '0.1.0',
      url: 'https://example.invalid/macos.tar.gz',
      sha256: sha,
      assets: { 'linux-x64': { url: 'https://example.invalid/linux.tar.gz', sha256: 'c'.repeat(64), entry: 'engine/bin/chameleon-pane' } },
    })
    expect(parseEngineAssets(good)?.['linux-x64']?.entry).toBe('engine/bin/chameleon-pane')
  })

  test('assets の行に windowEntry(ウィンドウ方式の実行ファイル)を足せる', () => {
    const windowEntry = 'sukoshi-tako-engine/SukoshiTako.app/Contents/MacOS/ChameleonPane'
    const text = JSON.stringify({
      version: '0.1.0',
      url: 'https://example.invalid/macos.tar.gz',
      sha256: sha,
      assets: {
        darwin: {
          url: 'https://example.invalid/macos.tar.gz',
          sha256: sha,
          entry: 'sukoshi-tako-engine/ChameleonPane',
          windowEntry,
        },
      },
    })
    expect(parseEngineAssets(text)?.darwin).toEqual({
      url: 'https://example.invalid/macos.tar.gz',
      sha256: sha,
      entry: 'sukoshi-tako-engine/ChameleonPane',
      windowEntry,
    })
  })

  test('windowEntry の形が違うときは、無いものとして entry を使う', () => {
    for (const windowEntry of ['/abs/path', '../up', 'engine/../../x', 'a\\b', 'C:/x', '']) {
      const text = JSON.stringify({
        version: '0.1.0',
        url: 'https://example.invalid/macos.tar.gz',
        sha256: sha,
        assets: {
          darwin: { url: 'https://example.invalid/macos.tar.gz', sha256: sha, entry: 'e/ChameleonPane', windowEntry },
        },
      })
      const asset = parseEngineAssets(text)?.darwin
      expect(asset?.entry).toBe('e/ChameleonPane')
      expect(asset?.windowEntry).toBe(undefined)
    }
  })

  test('古い形(最上位だけ)には windowEntry を付けない', () => {
    expect(parseEngineAssets(oldShape)?.darwin?.windowEntry).toBe(undefined)
  })
})

describe('ハッシュの照合(Windows の出力)', () => {
  const sha = 'a'.repeat(64)

  test('certutil -hashfile の出力(1 行目が説明、2 行目がハッシュ、3 行目が完了)を読む', () => {
    const output =
      'SHA256 hash of C:\\Users\\tako\\AppData\\Local\\Temp\\engine.tar.gz:\r\n' +
      sha.toUpperCase() +
      '\r\n' +
      'CertUtil: -hashfile command completed successfully.\r\n'
    expect(checksumMatches(output, sha)).toBe(true)
    expect(checksumMatches(output, 'b'.repeat(64))).toBe(false)
  })

  test('sha256sum の出力(ハッシュとファイル名)を読む', () => {
    expect(checksumMatches(sha + '  engine.tar.gz\n', sha)).toBe(true)
  })

  test('どの行の語でもよく、最初に見つかった 64 文字の語を使う', () => {
    expect(checksumMatches('note ' + sha + ' ' + 'b'.repeat(64) + '\n', sha)).toBe(true)
    expect(checksumMatches('b'.repeat(64) + ' ' + sha + '\n', sha)).toBe(false)
    expect(checksumMatches('x' + sha + '\n', sha)).toBe(false)
    expect(checksumMatches(sha + '0\n', sha)).toBe(false)
  })
})

describe('取得の段取り', () => {
  const url = 'https://example.invalid/engine.tar.gz'

  test('darwin は、今の register.js が流しているコマンドと同じ', () => {
    // register.js の downloadEngine(enginePath 154-156、marker 175、取得と展開 186-196)と同じ並び
    expect(fetchPlan({ platform: 'darwin', root: '/plugin', url })).toEqual({
      archive: '/plugin/engine.tar.gz',
      distDir: '/plugin/dist',
      engineDir: '/plugin/dist/sukoshi-tako-engine',
      marker: '/plugin/dist/engine.sha256',
      download: ['curl', '-fsSL', '--retry', '2', '-o', '/plugin/engine.tar.gz', url],
      hash: ['shasum', '-a', '256', '/plugin/engine.tar.gz'],
      removeArchive: ['rm', '-f', '/plugin/engine.tar.gz'],
      removeOld: ['rm', '-rf', '/plugin/dist/sukoshi-tako-engine'],
      makeDist: ['mkdir', '-p', '/plugin/dist'],
      unpack: ['tar', '-xzf', '/plugin/engine.tar.gz', '-C', '/plugin/dist'],
    })
  })

  test('linux-x64 は sha256sum を使う', () => {
    const plan = fetchPlan({ platform: 'linux-x64', root: '/plugin', url })
    expect(plan?.archive).toBe('/plugin/engine.tar.gz')
    expect(plan?.hash).toEqual(['sha256sum', '/plugin/engine.tar.gz'])
    expect(plan?.download?.[0]).toBe('curl')
    expect(plan?.unpack).toEqual(['tar', '-xzf', '/plugin/engine.tar.gz', '-C', '/plugin/dist'])
  })

  test('win32-x64 は Windows 10 以降の curl.exe / certutil / tar.exe と \\ の区切りを使う', () => {
    expect(fetchPlan({ platform: 'win32-x64', root: 'C:\\tako', url })).toEqual({
      archive: 'C:\\tako\\engine.tar.gz',
      distDir: 'C:\\tako\\dist',
      engineDir: 'C:\\tako\\dist\\sukoshi-tako-engine',
      marker: 'C:\\tako\\dist\\engine.sha256',
      download: ['curl.exe', '-fsSL', '--retry', '2', '-o', 'C:\\tako\\engine.tar.gz', url],
      hash: ['certutil', '-hashfile', 'C:\\tako\\engine.tar.gz', 'SHA256'],
      removeArchive: ['cmd', '/c', 'del', '/f', '/q', 'C:\\tako\\engine.tar.gz'],
      removeOld: ['cmd', '/c', 'rmdir', '/s', '/q', 'C:\\tako\\dist\\sukoshi-tako-engine'],
      makeDist: ['cmd', '/c', 'mkdir', 'C:\\tako\\dist'],
      unpack: ['tar.exe', '-xzf', 'C:\\tako\\engine.tar.gz', '-C', 'C:\\tako\\dist'],
    })
  })

  test('知らない OS は null(何も取りに行かない)', () => {
    expect(fetchPlan({ platform: null, root: '/plugin', url })).toBe(null)
    expect(fetchPlan({ platform: 'freebsd-x64', root: '/plugin', url })).toBe(null)
  })
})

describe('エンジンの実行ファイルの場所', () => {
  test('darwin と linux-x64 は / の区切り', () => {
    expect(enginePathFor('/plugin', 'darwin', 'sukoshi-tako-engine/ChameleonPane')).toBe(
      '/plugin/dist/sukoshi-tako-engine/ChameleonPane',
    )
    expect(enginePathFor('/plugin', 'linux-x64', 'engine/chameleon-pane')).toBe('/plugin/dist/engine/chameleon-pane')
  })

  test('win32-x64 は entry の / を \\ に替える', () => {
    expect(enginePathFor('C:\\tako', 'win32-x64', 'sukoshi-tako-engine/ChameleonPane.exe')).toBe(
      'C:\\tako\\dist\\sukoshi-tako-engine\\ChameleonPane.exe',
    )
  })

  test('知らない OS は null', () => {
    expect(enginePathFor('/plugin', null, 'engine/ChameleonPane')).toBe(null)
  })
})

describe('ウィンドウ方式の実行ファイル', () => {
  const asset = {
    entry: 'sukoshi-tako-engine/ChameleonPane',
    windowEntry: 'sukoshi-tako-engine/SukoshiTako.app/Contents/MacOS/ChameleonPane',
  }

  test('windowEntry があれば、ウィンドウ方式はそちらを使う', () => {
    expect(engineEntryFor(asset, 'window')).toBe('sukoshi-tako-engine/SukoshiTako.app/Contents/MacOS/ChameleonPane')
    expect(engineEntryFor(asset, 'pane')).toBe('sukoshi-tako-engine/ChameleonPane')
    expect(engineEntryFor(asset, 'none')).toBe('sukoshi-tako-engine/ChameleonPane')
  })

  test('windowEntry が無ければ、ウィンドウ方式も entry を使う', () => {
    expect(engineEntryFor({ entry: 'e/ChameleonPane' }, 'window')).toBe('e/ChameleonPane')
    expect(engineEntryFor(null, 'window')).toBe(null)
  })
})

describe('素材のパックの場所', () => {
  test('展開先の sukoshi-tako-engine フォルダの assets.pack', () => {
    expect(packPathFor('/plugin/dist/sukoshi-tako-engine', 'darwin')).toBe('/plugin/dist/sukoshi-tako-engine/assets.pack')
    expect(packPathFor('C:\\tako\\dist\\sukoshi-tako-engine', 'win32-x64')).toBe(
      'C:\\tako\\dist\\sukoshi-tako-engine\\assets.pack',
    )
  })

  test('置き場所が分からないときは null', () => {
    expect(packPathFor('', 'darwin')).toBe(null)
    expect(packPathFor(null, 'darwin')).toBe(null)
  })
})

describe('絶対パスの見分け', () => {
  test('文字列でなければ false', () => {
    expect(isAbsolutePath(undefined, 'darwin')).toBe(false)
    expect(isAbsolutePath(42, 'win32-x64')).toBe(false)
  })

  test('/ で始まれば、win32-x64 以外では絶対パス', () => {
    expect(isAbsolutePath('/opt/dev', undefined)).toBe(true)
    expect(isAbsolutePath('/opt/dev', 'darwin')).toBe(true)
    expect(isAbsolutePath('/opt/dev', 'linux-x64')).toBe(true)
    expect(isAbsolutePath('relative/dev', 'darwin')).toBe(false)
  })

  test('win32-x64 はドライブ文字が要る(/ で始まるだけでは足りない)', () => {
    expect(isAbsolutePath('C:\\dev\\ChameleonPane.exe', 'win32-x64')).toBe(true)
    expect(isAbsolutePath('c:/dev/ChameleonPane.exe', 'win32-x64')).toBe(true)
    expect(isAbsolutePath('C:dev', 'win32-x64')).toBe(false)
    expect(isAbsolutePath('\\\\server\\share', 'win32-x64')).toBe(false)
    expect(isAbsolutePath('/opt/dev', 'win32-x64')).toBe(false)
  })
})

describe('入力ファイルの置き場所(Windows)', () => {
  test('win32-x64 は %TEMP% に置き、絶対パスでなければ null(/tmp には戻さない)', () => {
    expect(inputPathFor('C:\\Users\\tako\\AppData\\Local\\Temp\\', 'ab12', 'win32-x64')).toBe(
      'C:\\Users\\tako\\AppData\\Local\\Temp\\sukoshi-tako-ab12.input',
    )
    expect(inputPathFor('C:/Temp/', 'ab12', 'win32-x64')).toBe('C:/Temp\\sukoshi-tako-ab12.input')
    expect(inputPathFor('/tmp', 'ab12', 'win32-x64')).toBe(null)
    expect(inputPathFor('relative', 'ab12', 'win32-x64')).toBe(null)
    expect(inputPathFor(undefined, 'ab12', 'win32-x64')).toBe(null)
  })

  test('win32-x64 以外は今までどおり', () => {
    expect(inputPathFor('/var/folders/ab/T', 'ab12', 'darwin')).toBe('/var/folders/ab/T/sukoshi-tako-ab12.input')
    expect(inputPathFor('relative', 'ab12', 'linux-x64')).toBe('/tmp/sukoshi-tako-ab12.input')
  })
})

describe('開発用のゲーム本体の指定(Windows)', () => {
  test('win32-x64 は C:\\ の形を受け付け、/ で始まるだけのものは受け付けない', () => {
    expect(resolveEngineOverride('C:\\dev\\ChameleonPane.exe', '1', 'win32-x64', true)).toBe('C:\\dev\\ChameleonPane.exe')
    expect(resolveEngineOverride('C:/dev/ChameleonPane.exe', '1', 'win32-x64', true)).toBe('C:/dev/ChameleonPane.exe')
    expect(resolveEngineOverride('/opt/dev/ChameleonPane', '1', 'win32-x64', true)).toBe(null)
    expect(resolveEngineOverride('fake', '1', 'win32-x64', true)).toBe('fake')
    expect(resolveEngineOverride('C:\\dev\\ChameleonPane.exe', undefined, 'win32-x64')).toBe(null)
  })

  test('darwin / linux-x64 / 省略は今までどおり', () => {
    expect(resolveEngineOverride('/opt/dev/ChameleonPane', '1', 'darwin', true)).toBe('/opt/dev/ChameleonPane')
    expect(resolveEngineOverride('/opt/dev/ChameleonPane', '1', 'linux-x64', true)).toBe('/opt/dev/ChameleonPane')
    expect(resolveEngineOverride('./evil', '1', 'linux-x64', true)).toBe(null)
  })
})

describe('ウィンドウ方式の入力ファイル', () => {
  const pointer = {
    ...idlePointer(),
    isLeftDown: true,
    isRightDown: true,
    x: 0.4,
    y: 0.6,
    leftDowns: 3,
    leftUps: 2,
    rightDowns: 1,
    rightUps: 4,
  }

  test('キーとマウスは載せず、1 行目は遊んでいるかだけ', () => {
    const text = inputFileText({
      isPlaying: true,
      keys: ['w', 'space'],
      pointer,
      events: [{ id: 7, name: 'stage:burgerland-a' }],
      mode: 'window',
    })
    expect(text).toBe('1\nP 0 0 0.0000 0.0000 0 0 0 0\nE 7:stage:burgerland-a\n')
  })

  test('遊んでいないときは 1 行目が 0。3 行で、必ず改行で終わる', () => {
    const text = inputFileText({ isPlaying: false, keys: ['w'], pointer, events: [{ id: 1, name: 'retry' }], mode: 'window' })
    expect(text).toBe('0\nP 0 0 0.0000 0.0000 0 0 0 0\nE 1:retry\n')
    expect(text.split('\n').length - 1).toBe(3)
    expect(text.endsWith('\n')).toBe(true)
  })

  test('mode が pane か、無いときは今までと同じ', () => {
    const args = {
      isPlaying: true,
      keys: ['d'],
      pointer: { ...idlePointer(), x: 0.25, leftDowns: 1 },
      events: [{ id: 2, name: 'world_seek' }],
    }
    const expected = '1 d\nP 0 0 0.2500 0.0000 1 0 0 0\nE 2:world_seek\n'
    expect(inputFileText({ ...args, mode: 'pane' })).toBe(expected)
    expect(inputFileText(args)).toBe(expected)
  })
})

// コマンドは、ターミナルでもデスクトップアプリでも同じ名前にする。デスクトップアプリが一覧に
// 載せるのはファイルで宣言したコマンドだけで、その名前は <プラグイン名>:<コマンド名> になる。
describe('commandNames / commandAction', () => {
  test('one name to play and one to turn it off, both file-declared', () => {
    expect(commandNames('tako')).toEqual(['tako:play', 'tako:off'])
  })

  test('the off command turns it off, whatever it is given', () => {
    expect(commandAction('tako:off', '')).toBe('off')
    expect(commandAction('tako:off', undefined)).toBe('off')
    expect(commandAction('tako:off', 'on')).toBe('off')
  })

  test('play turns it on', () => {
    expect(commandAction('tako:play', '')).toBe('on')
    expect(commandAction('tako:play', undefined)).toBe('on')
    expect(commandAction('tako:play', 'on')).toBe('on')
  })

  test('play off still turns it off, whatever the spacing or case', () => {
    expect(commandAction('tako:play', 'off')).toBe('off')
    expect(commandAction('tako:play', '  OFF ')).toBe('off')
  })
})

// /tako:play を送ったのに、画面に何も出ないまま止まった(Windows のデスクトップアプリ、2026-10-06)。
// 返事の文が無く、ゲームの開始が「ペインが描かれたこと」だけに掛かっていた。
describe('playCommandPlan', () => {
  test('surface unknown on a supported OS: start in a window now and say so in the chat', () => {
    for (const platform of ['win32-x64', 'linux-x64', 'darwin']) {
      expect(playCommandPlan({ mode: null, platform })).toEqual({
        start: true,
        mode: 'window',
        waitsForPane: false,
        text: PLAY_STARTING_IN_WINDOW,
      })
    }
  })

  test('window mode: start and say so in the chat (the picture is not in the pane)', () => {
    expect(playCommandPlan({ mode: 'window', platform: 'win32-x64' })).toEqual({
      start: true,
      mode: 'window',
      waitsForPane: false,
      text: PLAY_STARTING_IN_WINDOW,
    })
  })

  test('pane mode: as before, the pane itself is the answer', () => {
    expect(playCommandPlan({ mode: 'pane', platform: 'darwin' })).toEqual({
      start: true,
      mode: 'pane',
      waitsForPane: true,
      text: null,
    })
  })

  test('cannot play here: do not start, say why', () => {
    expect(playCommandPlan({ mode: 'none', platform: 'win32-x64' })).toEqual({
      start: false,
      mode: 'none',
      waitsForPane: false,
      text: NEEDS_LOCAL_SESSION,
    })
    expect(playCommandPlan({ mode: null, platform: null })).toEqual({
      start: false,
      mode: 'none',
      waitsForPane: false,
      text: NEEDS_OTHER_ENV,
    })
  })

  test('the chat line tells the person where to look when nothing shows up', () => {
    expect(PLAY_STARTING_IN_WINDOW).toContain('別のウィンドウ')
    expect(PLAY_STARTING_IN_WINDOW).toContain('すこしタコ')
  })
})

// 「始めます」の 1 行は出たのに、ゲームのウィンドウが出ないまま何も言わない(Windows、2026-10-06)。
// 失敗の理由はペインにしか出ず、本体がすぐ落ちた場合はペインにも出さずに閉じていた。
describe('失敗はチャットにも知らせる', () => {
  test('the engine died before it said anything: say the window could not open, with the exit code', () => {
    expect(engineEndNotice({ kind: 'crashed', result: { code: 3, signal: null }, sawOutput: false, tail: '' })).toBe(
      'すこしタコ: ゲームのウィンドウを開けませんでした(終了コード 3)。',
    )
  })

  test('the engine died after it had started: say it ended, with the exit code', () => {
    expect(engineEndNotice({ kind: 'crashed', result: { code: 1, signal: null }, sawOutput: true, tail: '' })).toBe(
      'すこしタコ: ゲームが途中で終わりました(終了コード 1)。',
    )
  })

  test('a signal or no record at all is named as such', () => {
    expect(engineEndNotice({ kind: 'crashed', result: { code: null, signal: 'SIGSEGV' }, sawOutput: false, tail: '' })).toContain(
      '(シグナル SIGSEGV)',
    )
    expect(engineEndNotice({ kind: 'crashed', result: undefined, sawOutput: false, tail: '' })).toContain('(終了の記録なし)')
  })

  test('what the engine printed last rides along, for whoever is asked to look at it', () => {
    expect(
      engineEndNotice({ kind: 'crashed', result: { code: 1, signal: null }, sawOutput: false, tail: ' GLFW: no OpenGL 3.3\n' }),
    ).toBe('すこしタコ: ゲームのウィンドウを開けませんでした(終了コード 1)。\n本体の最後の出力: GLFW: no OpenGL 3.3')
  })

  test('closed by the person, stopped by the plugin, or already explained: nothing more to say', () => {
    for (const kind of ['closed', 'stopped', 'fatal']) {
      expect(engineEndNotice({ kind, result: { code: 0, signal: null }, sawOutput: true, tail: 'x' })).toBe(null)
    }
  })

  test('a crash counts as a failure, so the pane is not closed quietly', () => {
    expect(engineEndAction({ mode: 'window', hasFailure: true, isPlaying: true })).toBe('markEnded')
  })

  test('a failure while preparing is passed on as it is', () => {
    expect(failureNotice('ゲーム本体を取得できませんでした。')).toBe('すこしタコ: ゲーム本体を取得できませんでした。')
    expect(failureNotice(null)).toBe(null)
    expect(failureNotice('')).toBe(null)
  })

  test('only the end of what the engine printed is kept', () => {
    expect(outputTail('', 'abc')).toBe('abc')
    expect(outputTail('abc', 'def')).toBe('abcdef')
    expect(outputTail('a'.repeat(390), 'b'.repeat(20)).length).toBe(400)
    expect(outputTail('a'.repeat(390), 'b'.repeat(20)).endsWith('b'.repeat(20))).toBe(true)
  })
})

// デスクトップアプリのチャットに確実に出せるのは、コマンドの返事だけ(あとから足す知らせは出ない。
// 2026-10-06 に同じ通信で確かめた)。だから /tako:play は、始まったか失敗したかが分かるまで待って答える。
describe('playOutcomeText', () => {
  test('the engine answered: say it started and where it is', () => {
    const text = playOutcomeText({ kind: 'started' })
    expect(text).toContain('始めました')
    expect(text).toContain('別のウィンドウ')
  })

  test('it failed: the reason is the answer', () => {
    expect(playOutcomeText({ kind: 'failed', text: 'すこしタコ: ゲームのウィンドウを開けませんでした(終了コード 3)。' })).toBe(
      'すこしタコ: ゲームのウィンドウを開けませんでした(終了コード 3)。',
    )
  })

  test('still fetching when the wait ran out: say so and what to do', () => {
    const text = playOutcomeText({ kind: 'waiting' })
    expect(text).toContain('準備')
    expect(text).toContain('/tako:play')
  })

  test('launched but silent when the wait ran out: say it may not have opened', () => {
    const text = playOutcomeText({ kind: 'silent' })
    expect(text).toContain('起動しました')
    expect(text).toContain('ウィンドウが出ない')
  })

  test('already running, stopped meanwhile, or closed right away', () => {
    expect(playOutcomeText({ kind: 'running' })).toContain('もう')
    expect(playOutcomeText({ kind: 'cancelled' })).toContain('止めました')
    expect(playOutcomeText({ kind: 'ended' })).toContain('終わりました')
  })

  test('the engine counts as up once it shows something, not while it is still loading', () => {
    expect(isEngineUp({ type: 'state', state: 'loading' })).toBe(false)
    expect(isEngineUp({ type: 'state', state: 'starting' })).toBe(false)
    expect(isEngineUp({ type: 'fatal', reason: 'x' })).toBe(false)
    expect(isEngineUp(null)).toBe(false)
    expect(isEngineUp({ type: 'state', state: 'menu' })).toBe(true)
    expect(isEngineUp({ type: 'state', state: 'hide' })).toBe(true)
    expect(isEngineUp({ type: 'stages', stages: [] })).toBe(true)
    expect(isEngineUp({ type: 'frame', name: 'f' })).toBe(true)
    expect(isEngineUp({ type: 'hud', text: 'h' })).toBe(true)
  })

  test('every answer names the game, and none is empty', () => {
    for (const kind of ['started', 'waiting', 'silent', 'running', 'cancelled', 'ended']) {
      expect(playOutcomeText({ kind })).toContain('すこしタコ')
    }
    expect(playOutcomeText({ kind: 'failed', text: '' })).toContain('すこしタコ')
  })
})

// 取得や起動の準備の途中でオフにした・ペインを閉じたら、その後で本体を起動しない。
describe('isStartStillWanted', () => {
  test('nothing happened while it was preparing: start', () => {
    expect(isStartStillWanted(3, 3)).toBe(true)
  })

  test('turned off or closed while it was preparing: do not start', () => {
    expect(isStartStillWanted(3, 4)).toBe(false)
  })
})

describe('removeFileArgv', () => {
  test('rm on macOS and Linux, del on Windows (which has no rm)', () => {
    expect(removeFileArgv('/tmp/a.input', 'darwin')).toEqual(['rm', '-f', '/tmp/a.input'])
    expect(removeFileArgv('/tmp/a.input', 'linux-x64')).toEqual(['rm', '-f', '/tmp/a.input'])
    expect(removeFileArgv('C:\\T\\a.input', 'win32-x64')).toEqual(['cmd', '/c', 'del', '/f', '/q', 'C:\\T\\a.input'])
  })
})

// cmd /c はシェルなので、Windows では場所に cmd の特殊文字があるときは何も取りに行かない。
describe('fetchPlan on Windows refuses a root cmd would reinterpret', () => {
  test('ordinary roots, with spaces too, are planned', () => {
    expect(fetchPlan({ platform: 'win32-x64', root: 'C:\\Users\\ta ko\\plugin', url: 'https://example.invalid/a.tar.gz' })).not.toBe(null)
  })

  test('a root with a cmd metacharacter is refused', () => {
    for (const bad of ['C:\\p\\tako&calc', 'C:\\p\\a|b', 'C:\\p\\a>b', 'C:\\p\\a<b', 'C:\\p\\a^b', 'C:\\p\\%TEMP%', 'C:\\p\\a"b', 'C:\\p\\a!b', 'C:\\p\\(a)']) {
      expect(fetchPlan({ platform: 'win32-x64', root: bad, url: 'https://example.invalid/a.tar.gz' })).toBe(null)
    }
  })

  test('the same characters are harmless without a shell (macOS, Linux)', () => {
    expect(fetchPlan({ platform: 'darwin', root: '/p/tako&calc', url: 'https://example.invalid/a.tar.gz' })).not.toBe(null)
  })
})

// 本体が送る状態の行(key=value; …)は内部向けの書き方。人が読める形に直して出す。
describe('readableHud', () => {
  test('hide: the pose by its name, the two switches, no colour code and no button title', () => {
    expect(readableHud('色=#808080; ポーズ=idle; 色を拾う=オフ; うつす=オフ; 確定=ここに隠れる')).toBe(
      'ポーズ: 立ち · 色を拾う: オフ · うつす: オフ',
    )
    expect(readableHud('色=#ff0000; ポーズ=crouch; 色を拾う=オン; うつす=オフ; 確定=ここに隠れる')).toBe(
      'ポーズ: しゃがみ · 色を拾う: オン · うつす: オフ',
    )
  })

  test('a pose it does not know is shown as it came', () => {
    expect(readableHud('ポーズ=handstand')).toBe('ポーズ: handstand')
  })

  test('seek: the two counts, without the button titles', () => {
    expect(readableHud('探す=みつけた 0 / のこり 2 / さがし終わり / 背後 / 中')).toBe('みつけた 0 · のこり 2')
  })

  test('nothing, or a line in another form, is passed through', () => {
    expect(readableHud('')).toBe('')
    expect(readableHud(undefined)).toBe('')
    expect(readableHud('そのままの文')).toBe('そのままの文')
  })
})

// ペインは大きめに頼む(頼みであって、置き場所が狭ければ小さくなる)。
describe('paneOpenArgs', () => {
  test('asks for a wide dock and a tall inline block', () => {
    expect(paneOpenArgs('p', 'T')).toEqual({ id: 'p', title: 'T', focus: true, columns: 120, rows: 40 })
  })
})

describe('imageCells', () => {
  test('fills the width when the height is unknown', () => {
    expect(imageCells(80, undefined, 3)).toEqual({ columns: 80, rows: rowsFor(80, PANE_WIDTH, PANE_HEIGHT) })
  })

  test('fills the width when there is room below', () => {
    expect(imageCells(80, 60, 3)).toEqual({ columns: 80, rows: rowsFor(80, PANE_WIDTH, PANE_HEIGHT) })
  })

  test('shrinks to leave the rows below, keeping 16:9', () => {
    const cells = imageCells(120, 30, 4)
    expect(cells.rows).toBe(26)
    expect(cells.columns).toBe(92)
  })

  test('never wider than the image element allows, never below one row', () => {
    expect(imageCells(400, undefined, 3).columns).toBe(255)
    expect(imageCells(80, 2, 4).rows).toBe(1)
  })
})

// ウィンドウ方式にペインの大きさを渡すと、ゲームのウィンドウが小さく開く。
describe('engineSize', () => {
  test('the pane way draws at the pane size', () => {
    expect(engineSize('pane')).toEqual({ width: PANE_WIDTH, height: PANE_HEIGHT })
  })

  test('the window way opens larger, at the same 16:9', () => {
    expect(engineSize('window')).toEqual({ width: 1280, height: 720 })
  })
})

// 起動直後やコマンドの時点では、どの表示先で描いているかがまだ分からないことがある。
describe('surfaceOrGuess', () => {
  test('a known surface is used as it is', () => {
    expect(surfaceOrGuess('desktop', true)).toBe('desktop')
    expect(surfaceOrGuess('terminal', false)).toBe('terminal')
  })

  test('unknown, but the terminal can show pixels: it is the terminal (as before)', () => {
    expect(surfaceOrGuess(null, true)).toBe('terminal')
    expect(surfaceOrGuess(undefined, true)).toBe('terminal')
  })

  test('unknown and no pixels: still unknown, to be decided when the pane is drawn', () => {
    expect(surfaceOrGuess(null, false)).toBe(null)
    expect(surfaceOrGuess(null, null)).toBe(null)
  })
})

// ---- Step B5: Windows / Linux ----

describe('Windows / Linux の遊び方(表示先が未定のときも含む)', () => {
  test('Windows / Linux は、画素が出るかどうかに関わらず、ターミナルもデスクトップも window', () => {
    for (const platform of ['win32-x64', 'linux-x64']) {
      for (const surface of ['terminal', 'desktop']) {
        for (const hasPixels of [true, false, null]) {
          expect(playMode({ surface, hasPixels, platform })).toBe('window')
        }
      }
      for (const surface of ['mobile', 'vscode', null, undefined]) {
        expect(playMode({ surface, hasPixels: true, platform })).toBe('none')
      }
    }
  })

  test('Mac の答えは変えない(画素ありのターミナルだけ pane)', () => {
    expect(playMode({ surface: 'terminal', hasPixels: true, platform: 'darwin' })).toBe('pane')
    expect(playMode({ surface: 'terminal', hasPixels: false, platform: 'darwin' })).toBe('window')
    expect(playMode({ surface: 'desktop', hasPixels: true, platform: 'darwin' })).toBe('window')
  })

  test('表示先がまだ分からないとき: 画素が出るなら terminal と読んで window、出ないなら未定のまま(ペインを描くときに決める)', () => {
    for (const platform of ['win32-x64', 'linux-x64']) {
      const guessed = surfaceOrGuess(null, true)
      expect(guessed).toBe('terminal')
      expect(playMode({ surface: guessed, hasPixels: true, platform })).toBe('window')
    }
    expect(surfaceOrGuess(undefined, false)).toBe(null)
  })

  test('ペインを描く時点で表示先が分かれば、Windows のデスクトップで window になる', () => {
    expect(playMode({ surface: surfaceOrGuess('desktop', false), hasPixels: false, platform: 'win32-x64' })).toBe('window')
  })
})

describe('遊べないときの案内文(OS ごと)', () => {
  test('Mac は今までの文', () => {
    expect(unavailableText('darwin')).toBe(NEEDS_TERMINAL)
  })

  test('Windows / Linux で表示先が合わないときは、Local のセッションで開くよう案内する', () => {
    for (const platform of ['win32-x64', 'linux-x64']) {
      expect(unavailableText(platform)).toBe(NEEDS_LOCAL_SESSION)
    }
    expect(NEEDS_LOCAL_SESSION).toContain('Local')
  })

  test('対応していない OS・CPU は、Mac だけという言い方をしない', () => {
    expect(unavailableText(null)).toBe(NEEDS_OTHER_ENV)
    expect(unavailableText('freebsd-x64')).toBe(NEEDS_OTHER_ENV)
    expect(NEEDS_OTHER_ENV).not.toContain('macOS だけ')
  })

  test('どの文にも、専門用語やターミナル名を条件にした言い方が入らない', () => {
    for (const text of [NEEDS_LOCAL_SESSION, NEEDS_OTHER_ENV, noBuildText('win32-x64'), noBuildText('linux-x64')]) {
      for (const word of ['Ghostty', 'kitty', 'SHA', 'engine.json', 'asset']) expect(text).not.toContain(word)
    }
  })
})

describe('本体がウィンドウを開けなかったときの案内(OS ごと)', () => {
  test('Mac は今までの文のまま', () => {
    expect(windowUnavailableText('darwin')).toBe(WINDOW_UNAVAILABLE)
  })

  test('Windows / Linux は「この Mac」と言わず、Local のセッションを案内する', () => {
    for (const text of [WINDOW_UNAVAILABLE_WINDOWS, WINDOW_UNAVAILABLE_LINUX]) {
      expect(text).toContain('このセッションの種類では遊べません')
      expect(text).toContain('Local のセッションで開いてください')
      expect(text).not.toContain('この Mac')
    }
    expect(windowUnavailableText('win32-x64')).toBe(WINDOW_UNAVAILABLE_WINDOWS)
    expect(windowUnavailableText('linux-x64')).toBe(WINDOW_UNAVAILABLE_LINUX)
  })

  test('Linux は画面を出す仕組み(X11)が要ることを添える', () => {
    expect(WINDOW_UNAVAILABLE_LINUX).toContain('X11')
    expect(WINDOW_UNAVAILABLE_WINDOWS).not.toContain('X11')
  })

  test('paneView のエラー画面が、OS に合った案内を付ける', () => {
    const base = { scene: 'error', failure: 'the window could not be opened', stages: [], menuMode: null }
    expect(paneView({ ...base, platform: 'darwin' }, 'window').guidance).toBe(WINDOW_UNAVAILABLE)
    expect(paneView({ ...base, platform: 'win32-x64' }, 'window').guidance).toBe(WINDOW_UNAVAILABLE_WINDOWS)
    expect(paneView({ ...base, platform: 'linux-x64' }, 'window').guidance).toBe(WINDOW_UNAVAILABLE_LINUX)
    expect(paneView({ ...base, platform: 'win32-x64' }, 'pane').guidance).toBe(null)
  })

  test('この OS の本体がまだ無いときは、「ウィンドウを開けなかった」とは言わない', () => {
    const view = paneView(
      { scene: 'error', failure: noBuildText('win32-x64'), failureKind: 'noBuild', platform: 'win32-x64' },
      'window',
    )
    expect(view.text).toBe(noBuildText('win32-x64'))
    expect(view.guidance).toBe(null)
  })
})

// Mac の本体を直した不具合(PORTING.md 1.1): @state error の詳細がペインに出ていなかった
describe('@state error の詳細を画面に出す', () => {
  const base = { platform: 'darwin', stages: [], menuMode: null, failure: null }

  test('本体が送る 4 つの文が、そのまま出る', () => {
    for (const detail of [
      '少し待ってね',
      'そのコースには、まだ誰もいません',
      '通信に失敗しました。もう一度お試しください',
      'この版では、まだ隠れられません',
    ]) {
      const message = parseEngineLine('@state error ' + detail)
      expect(message).toEqual({ type: 'state', state: 'error', detail })
      for (const mode of ['pane', 'window'] as const) {
        const view = paneView({ ...base, scene: message?.state, sceneDetail: message?.detail }, mode)
        expect(view.kind).toBe('error')
        expect(view.text).toBe(detail)
        expect(view.button.label).toBe('もう一度')
      }
    }
  })

  test('詳細が無い error は、今までどおりの文', () => {
    const message = parseEngineLine('@state error')
    const view = paneView({ ...base, scene: message?.state, sceneDetail: message?.detail }, 'window')
    expect(view.text).toBe('うまく動いていません。')
  })

  test('@fatal や起動失敗の文(failure)は、詳細より優先して今までどおり出す', () => {
    const view = paneView({ ...base, scene: 'error', sceneDetail: '少し待ってね', failure: 'assets.pack was not found' }, 'window')
    expect(view.text).toBe('assets.pack was not found')
  })

  test('error 以外の場面の詳細は、error の文に混ざらない', () => {
    const view = paneView({ ...base, scene: 'unknown-word', sceneDetail: 'みつけた 1 · みつけられなかった 0' }, 'pane')
    expect(view.text).toBe('うまく動いていません。')
  })
})

// 新しい本体(native-engine)が実際に出す行の列を、プラグインの読み手に通す
describe('新しい本体の行', () => {
  const lines = [
    '@window starting',
    '@window shown',
    '@state loading',
    '@stages [{"id":"burgerland-a","name":"ミッドナイト・バーガーランド"},{"id":"sweets-a","name":"サンデー・スイーツガーデン"}]',
    '@state menu',
    '@window guide menu',
    '@window playing',
    '@state loading',
    '@state seek',
    '@hud 探す=みつけた 0 / のこり 2',
    '@window resting',
    '@state result みつけた 1 · みつけられなかった 1',
    '@state error 少し待ってね',
  ]

  test('@window の行は読み捨てる(場面にも状態にも影響しない)', () => {
    for (const line of lines.filter((l) => l.startsWith('@window'))) expect(parseEngineLine(line)).toBe(null)
  })

  test('それ以外は、Mac の本体と同じ形に読める', () => {
    const parsed = lines.map(parseEngineLine).filter((m) => m !== null)
    expect(parsed.map((m) => m.type)).toEqual(['state', 'stages', 'state', 'state', 'state', 'hud', 'state', 'state'])
    const stages = parsed.find((m) => m.type === 'stages')
    expect(stages.stages.map((s: { id: string }) => s.id)).toEqual(['burgerland-a', 'sweets-a'])
    expect(parsed.find((m) => m.type === 'hud').text).toBe('探す=みつけた 0 / のこり 2')
    expect(parsed.filter((m) => m.type === 'frame').length).toBe(0)
  })

  test('@fatal の 3 つの理由はそのまま理由として読める', () => {
    for (const reason of ['the window could not be opened', 'assets.pack was not found', 'assets.pack could not be read']) {
      expect(parseEngineLine('@fatal ' + reason)).toEqual({ type: 'fatal', reason })
    }
  })

  test('Windows の標準出力が \\r\\n で届いても、語が壊れない', () => {
    expect(parseEngineLine('@state menu\r')).toEqual({ type: 'state', state: 'menu', detail: '' })
    expect(parseEngineLine('@state error 少し待ってね\r')).toEqual({ type: 'state', state: 'error', detail: '少し待ってね' })
    expect(parseEngineLine('@fatal assets.pack was not found\r')).toEqual({ type: 'fatal', reason: 'assets.pack was not found' })
    expect(parseEngineLine('@hud 探す=みつけた 1 / のこり 1\r')).toEqual({ type: 'hud', text: '探す=みつけた 1 / のこり 1' })
    const split = splitLines('', '@state loading\r\n@state menu\r\n@sta')
    expect(split.lines.map(parseEngineLine)).toEqual([
      { type: 'state', state: 'loading', detail: '' },
      { type: 'state', state: 'menu', detail: '' },
    ])
    expect(split.pending).toBe('@sta')
  })

  test('日本語の行が、かたまりの途中で切れて届いても元に戻る', () => {
    let pending = ''
    const out: string[] = []
    for (const piece of ['@state error 少し', '待ってね\n@state me', 'nu\n']) {
      const split = splitLines(pending, piece)
      pending = split.pending
      out.push(...split.lines)
    }
    expect(out).toEqual(['@state error 少し待ってね', '@state menu'])
  })
})

describe('この OS の配布物があるか(resolveEngineAsset)', () => {
  const sha = 'a'.repeat(64)
  const darwinOnly = parseEngineAssets(
    JSON.stringify({
      version: '0.0.4',
      url: 'https://example.invalid/macos.tar.gz',
      sha256: sha,
      assets: { darwin: { url: 'https://example.invalid/macos.tar.gz', sha256: sha, entry: 'sukoshi-tako-engine/ChameleonPane' } },
    }),
  )
  const withWindows = parseEngineAssets(
    JSON.stringify({
      version: '0.1.0',
      url: 'https://example.invalid/macos.tar.gz',
      sha256: sha,
      assets: {
        darwin: { url: 'https://example.invalid/macos.tar.gz', sha256: sha, entry: 'sukoshi-tako-engine/ChameleonPane' },
        'win32-x64': {
          url: 'https://example.invalid/win.tar.gz',
          sha256: 'b'.repeat(64),
          entry: 'sukoshi-tako-engine/sukoshi-tako.exe',
        },
        'linux-x64': {
          url: 'https://example.invalid/linux.tar.gz',
          sha256: 'c'.repeat(64),
          entry: 'sukoshi-tako-engine/sukoshi-tako',
        },
      },
    }),
  )

  test('いま出している engine.json の形(Mac だけ)でも、Mac は通る', () => {
    const found = resolveEngineAsset(darwinOnly, 'darwin')
    expect(found.ok).toBe(true)
    expect(found.asset.entry).toBe('sukoshi-tako-engine/ChameleonPane')
  })

  test('Windows / Linux の行が無いときは、落ちずに「まだ無い」と分かる案内になる', () => {
    for (const [platform, name] of [['win32-x64', 'Windows'], ['linux-x64', 'Linux']] as const) {
      const found = resolveEngineAsset(darwinOnly, platform)
      expect(found.ok).toBe(false)
      expect(found.kind).toBe('noBuild')
      expect(found.text).toBe(noBuildText(platform))
      expect(found.text).toContain(name)
      expect(found.text).toContain('まだ')
    }
  })

  test('Windows / Linux の行があれば、取得に進める(取得の組み立てが null にならない)', () => {
    for (const platform of ['win32-x64', 'linux-x64']) {
      const found = resolveEngineAsset(withWindows, platform)
      expect(found.ok).toBe(true)
      const plan = fetchPlan({ platform, root: platform === 'win32-x64' ? 'C:\\plugin' : '/plugin', url: found.asset.url })
      expect(plan).not.toBe(null)
      expect(found.asset.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(resolveEngineAsset(withWindows, 'win32-x64').asset.entry).toBe('sukoshi-tako-engine/sukoshi-tako.exe')
  })

  test('対応していない OS・CPU は unsupported', () => {
    for (const platform of [null, undefined, 'freebsd-x64']) {
      const found = resolveEngineAsset(withWindows, platform)
      expect(found).toEqual({ ok: false, kind: 'unsupported', text: NEEDS_OTHER_ENV })
    }
  })

  test('engine.json が読めなかったときは manifest', () => {
    expect(resolveEngineAsset(null, 'darwin')).toEqual({ ok: false, kind: 'manifest', text: 'engine.json が読めません。' })
  })

  test('Windows 向けの行が壊れているときは、無いものとして扱う(落ちない)', () => {
    const broken = parseEngineAssets(
      JSON.stringify({
        version: '0.1.0',
        url: 'https://example.invalid/macos.tar.gz',
        sha256: sha,
        assets: { 'win32-x64': { url: 'https://example.invalid/win.tar.gz', sha256: 'short', entry: 'e/x.exe' } },
      }),
    )
    expect(resolveEngineAsset(broken, 'win32-x64').kind).toBe('noBuild')
    expect(resolveEngineAsset(broken, 'darwin').ok).toBe(true)
  })
})

describe('本体の起動(argv と環境変数)', () => {
  const asset = { url: 'u', sha256: 'a'.repeat(64), entry: 'sukoshi-tako-engine/sukoshi-tako.exe' }

  test('Windows: \\ 区切りの exe と、環境変数一式(共有メモリの名前は渡さない)', () => {
    const root = 'C:\\Users\\taro\\.claude\\plugins\\cache\\tako'
    const request = launchRequest({
      platform: 'win32-x64',
      mode: 'window',
      root,
      asset,
      engineDir: root + '\\dist\\sukoshi-tako-engine',
      id: 'ab12',
      inputPath: 'C:\\Users\\taro\\AppData\\Local\\Temp\\sukoshi-tako-ab12.input',
    })
    expect(request).toEqual({
      argv: [root + '\\dist\\sukoshi-tako-engine\\sukoshi-tako.exe'],
      env: {
        SUKOSHI_TAKO_MODE: 'window',
        SUKOSHI_TAKO_INPUT: 'C:\\Users\\taro\\AppData\\Local\\Temp\\sukoshi-tako-ab12.input',
        SUKOSHI_TAKO_PACK: root + '\\dist\\sukoshi-tako-engine\\assets.pack',
        SUKOSHI_TAKO_WIDTH: '1280',
        SUKOSHI_TAKO_HEIGHT: '720',
      },
    })
  })

  test('Windows: 空白入りと日本語入りのフォルダでも、パスは 1 つの引数のまま・文字を変えずに組み立てる', () => {
    for (const user of ['ta ro', '山田 太郎', 'ユーザー']) {
      const root = `C:\\Users\\${user}\\.claude\\plugins\\tako 1.0`
      const plan = fetchPlan({ platform: 'win32-x64', root, url: 'https://example.invalid/w.tar.gz' })
      expect(plan).not.toBe(null)
      expect(plan?.unpack).toEqual(['tar.exe', '-xzf', root + '\\engine.tar.gz', '-C', root + '\\dist'])
      expect(plan?.hash).toEqual(['certutil', '-hashfile', root + '\\engine.tar.gz', 'SHA256'])
      expect(plan?.removeOld).toEqual(['cmd', '/c', 'rmdir', '/s', '/q', root + '\\dist\\sukoshi-tako-engine'])
      const request = launchRequest({
        platform: 'win32-x64',
        mode: 'window',
        root,
        asset,
        engineDir: plan?.engineDir,
        id: 'ab12',
        inputPath: inputPathFor(`C:\\Users\\${user}\\AppData\\Local\\Temp`, 'ab12', 'win32-x64'),
      })
      expect(request?.argv).toEqual([root + '\\dist\\sukoshi-tako-engine\\sukoshi-tako.exe'])
      expect(request?.argv.length).toBe(1)
      expect(request?.env.SUKOSHI_TAKO_PACK).toBe(root + '\\dist\\sukoshi-tako-engine\\assets.pack')
      expect(request?.env.SUKOSHI_TAKO_INPUT).toBe(`C:\\Users\\${user}\\AppData\\Local\\Temp\\sukoshi-tako-ab12.input`)
      expect(isAbsolutePath(request?.argv[0], 'win32-x64')).toBe(true)
      expect(isAbsolutePath(request?.env.SUKOSHI_TAKO_PACK, 'win32-x64')).toBe(true)
    }
  })

  test('Windows: root が / 区切りで届いても、cmd に渡す側は \\ にそろえる(cmd は / をオプションと読む)', () => {
    const plan = fetchPlan({ platform: 'win32-x64', root: 'C:/Home/ta ro/plugin/', url: 'https://example.invalid/w.tar.gz' })
    expect(plan?.archive).toBe('C:\\Home\\ta ro\\plugin\\engine.tar.gz')
    expect(plan?.removeOld).toEqual(['cmd', '/c', 'rmdir', '/s', '/q', 'C:\\Home\\ta ro\\plugin\\dist\\sukoshi-tako-engine'])
    expect(enginePathFor('C:/Home/ta ro/plugin/', 'win32-x64', 'sukoshi-tako-engine/x.exe')).toBe(
      'C:\\Home\\ta ro\\plugin\\dist\\sukoshi-tako-engine\\x.exe',
    )
    expect(removeFileArgv('C:/Temp/a.input', 'win32-x64')).toEqual(['cmd', '/c', 'del', '/f', '/q', 'C:\\Temp\\a.input'])
  })

  test('Linux: / 区切り。空白入りでも 1 つの引数', () => {
    const root = '/home/ta ro/.claude/plugins/tako'
    const request = launchRequest({
      platform: 'linux-x64',
      mode: 'window',
      root,
      asset: { ...asset, entry: 'sukoshi-tako-engine/sukoshi-tako' },
      engineDir: root + '/dist/sukoshi-tako-engine',
      id: 'ab12',
      inputPath: '/tmp/sukoshi-tako-ab12.input',
    })
    expect(request?.argv).toEqual([root + '/dist/sukoshi-tako-engine/sukoshi-tako'])
    expect(request?.env.SUKOSHI_TAKO_MODE).toBe('window')
    expect(request?.env.SUKOSHI_TAKO_PACK).toBe(root + '/dist/sukoshi-tako-engine/assets.pack')
    expect(request?.env).not.toHaveProperty('SUKOSHI_TAKO_FRAMES')
  })

  test('Mac: 今までと同じ(共有メモリの名前を渡し、ウィンドウ方式は windowEntry、パックは展開先)', () => {
    const macAsset = {
      url: 'u',
      sha256: 'a'.repeat(64),
      entry: 'sukoshi-tako-engine/ChameleonPane',
      windowEntry: 'sukoshi-tako-engine/SukoshiTako.app/Contents/MacOS/ChameleonPane',
    }
    const common = { platform: 'darwin', root: '/plugin', asset: macAsset, engineDir: '/plugin/dist/sukoshi-tako-engine', id: 'ab12', inputPath: '/var/T/x.input' }
    expect(launchRequest({ ...common, mode: 'pane' })).toEqual({
      argv: ['/plugin/dist/sukoshi-tako-engine/ChameleonPane'],
      env: {
        SUKOSHI_TAKO_FRAMES: '/tkab12-',
        SUKOSHI_TAKO_INPUT: '/var/T/x.input',
        SUKOSHI_TAKO_WIDTH: '640',
        SUKOSHI_TAKO_HEIGHT: '360',
        SUKOSHI_TAKO_MODE: 'pane',
        SUKOSHI_TAKO_PACK: '/plugin/dist/sukoshi-tako-engine/assets.pack',
      },
    })
    expect(launchRequest({ ...common, mode: 'window' })).toEqual({
      argv: ['/plugin/dist/sukoshi-tako-engine/SukoshiTako.app/Contents/MacOS/ChameleonPane'],
      env: {
        SUKOSHI_TAKO_FRAMES: '/tkab12-',
        SUKOSHI_TAKO_INPUT: '/var/T/x.input',
        SUKOSHI_TAKO_WIDTH: '1280',
        SUKOSHI_TAKO_HEIGHT: '720',
        SUKOSHI_TAKO_MODE: 'window',
        SUKOSHI_TAKO_PACK: '/plugin/dist/sukoshi-tako-engine/assets.pack',
      },
    })
  })

  test('知らない OS や、置き場所が分からないときは null(何も起動しない)', () => {
    expect(launchRequest({ platform: null, mode: 'window', root: '/p', asset, engineDir: '/p/d', id: 'a', inputPath: '/x' })).toBe(null)
  })

  test('engineEnv は、入力ファイルの場所と大きさとモードを必ず入れる', () => {
    const env = engineEnv({ platform: 'win32-x64', mode: 'window', id: 'ab12', inputPath: 'C:\\T\\a.input', packPath: null })
    expect(env.SUKOSHI_TAKO_INPUT).toBe('C:\\T\\a.input')
    expect(env.SUKOSHI_TAKO_MODE).toBe('window')
    expect(env).not.toHaveProperty('SUKOSHI_TAKO_PACK')
  })
})

describe('開発用の本体の上書き(OS を渡す)', () => {
  const common = { mode: 'window', id: 'ab12', inputPath: 'C:\\T\\a.input', root: 'C:\\plugin' }

  test('Windows: C:\\ の絶対パスはそのまま argv に。Mac 用の DYLD_ は付けない', () => {
    const request = devEngineRequest({ ...common, platform: 'win32-x64', override: 'C:\\dev\\sukoshi-tako.exe' })
    expect(request?.argv).toEqual(['C:\\dev\\sukoshi-tako.exe'])
    expect(request?.env).not.toHaveProperty('DYLD_FRAMEWORK_PATH')
    expect(request?.env.SUKOSHI_TAKO_INPUT).toBe('C:\\T\\a.input')
  })

  test('Mac: 今までどおり隣のフレームワークを教える', () => {
    const request = devEngineRequest({ ...common, platform: 'darwin', mode: 'pane', inputPath: '/x.input', root: '/p', override: '/opt/dev/ChameleonPane' })
    expect(request?.argv).toEqual(['/opt/dev/ChameleonPane'])
    expect(request?.env.DYLD_FRAMEWORK_PATH).toBe('/opt/dev:/opt/dev/PackageFrameworks')
  })

  test('Linux: DYLD_ は付けない', () => {
    const request = devEngineRequest({ ...common, platform: 'linux-x64', inputPath: '/x.input', root: '/p', override: '/opt/dev/sukoshi-tako' })
    expect(request?.env).not.toHaveProperty('DYLD_FRAMEWORK_PATH')
  })

  test('fake は同梱の偽エンジンを python3 で', () => {
    expect(devEngineRequest({ ...common, platform: 'darwin', inputPath: '/x', root: '/p', override: 'fake' })?.argv).toEqual([
      'python3',
      '-u',
      '/p/dev/fake_engine.py',
    ])
  })
})

// Windows では、止めた子も「終了コード」で返る(signal は null)。コードだけでは「人が閉じた」「プラグインが止めた」
// 「落ちた」を見分けられないので、止めたかどうかは自分の記録で決める。
describe('本体の終わり方の解釈', () => {
  test('プラグインが止めたなら、Windows のように kill が終了コード 1 で返っても stopped', () => {
    expect(classifyEngineEnd({ result: { code: 1, signal: null }, stopRequested: true, hasFatal: false })).toBe('stopped')
    expect(classifyEngineEnd({ result: { code: null, signal: 'SIGTERM' }, stopRequested: true, hasFatal: false })).toBe('stopped')
    expect(classifyEngineEnd({ result: { code: 0, signal: null }, stopRequested: true, hasFatal: false })).toBe('stopped')
    expect(classifyEngineEnd({ result: undefined, stopRequested: true, hasFatal: false })).toBe('stopped')
  })

  test('止めていないのに終了コード 0 なら、人がウィンドウを閉じた(入力ファイルが消えて自分で終わった場合も同じ)', () => {
    expect(classifyEngineEnd({ result: { code: 0, signal: null }, stopRequested: false, hasFatal: false })).toBe('closed')
  })

  test('止めていないのに 0 以外・signal なら、落ちた', () => {
    expect(classifyEngineEnd({ result: { code: 1, signal: null }, stopRequested: false, hasFatal: false })).toBe('crashed')
    expect(classifyEngineEnd({ result: { code: -1073741819, signal: null }, stopRequested: false, hasFatal: false })).toBe('crashed')
    expect(classifyEngineEnd({ result: { code: null, signal: 'SIGSEGV' }, stopRequested: false, hasFatal: false })).toBe('crashed')
    expect(classifyEngineEnd({ result: undefined, stopRequested: false, hasFatal: false })).toBe('crashed')
  })

  test('@fatal を受けたあとの終了は、コードに関わらず fatal(理由は既に画面にある)', () => {
    expect(classifyEngineEnd({ result: { code: 1, signal: null }, stopRequested: false, hasFatal: true })).toBe('fatal')
    expect(classifyEngineEnd({ result: { code: 0, signal: null }, stopRequested: true, hasFatal: true })).toBe('fatal')
  })

  // Mac で今やっていることを、そのまま固定する(OS に依らない)
  test('終わったあとの画面: ウィンドウ方式で失敗が無ければ静かにペインを閉じる', () => {
    expect(engineEndAction({ mode: 'window', hasFailure: false, isPlaying: true })).toBe('closePane')
    expect(engineEndAction({ mode: 'window', hasFailure: false, isPlaying: false })).toBe('closePane')
  })

  test('終わったあとの画面: 失敗があるか、ペイン方式なら、遊んでいた最中だけ「終了しました」', () => {
    expect(engineEndAction({ mode: 'window', hasFailure: true, isPlaying: true })).toBe('markEnded')
    expect(engineEndAction({ mode: 'window', hasFailure: true, isPlaying: false })).toBe('none')
    expect(engineEndAction({ mode: 'pane', hasFailure: false, isPlaying: true })).toBe('markEnded')
    expect(engineEndAction({ mode: 'pane', hasFailure: false, isPlaying: false })).toBe('none')
    expect(engineEndAction({ mode: 'pane', hasFailure: true, isPlaying: false })).toBe('none')
  })
})

describe('レビューの直し(2026-10-05)', () => {
  test('本体が @state error で伝えた失敗(少し待ってね、など)には、ウィンドウを開けなかった案内を付けない', () => {
    const state = { ...initialState(), scene: 'error', sceneDetail: '少し待ってね', failure: null, failureKind: null, platform: 'win32-x64' }
    const view = paneView(state, 'window')
    expect(view.text).toBe('少し待ってね')
    expect(view.guidance).toBe(null)
  })

  test('Windows の入力ファイルの場所に cmd の特殊文字があれば、cmd に渡さない(後始末を諦める)', () => {
    expect(removeFileArgv('C:\\Users\\A&B\\AppData\\Local\\Temp\\sukoshi-tako-ab12.input', 'win32-x64')).toBe(null)
    expect(removeFileArgv('C:\\Users\\100%\\Temp\\a.input', 'win32-x64')).toBe(null)
    // 空白と日本語は通す
    expect(removeFileArgv('C:\\Users\\山田 太郎\\AppData\\Local\\Temp\\a.input', 'win32-x64')).toEqual([
      'cmd', '/c', 'del', '/f', '/q', 'C:\\Users\\山田 太郎\\AppData\\Local\\Temp\\a.input',
    ])
    // Mac / Linux は cmd を通さないので、そのまま
    expect(removeFileArgv('/tmp/a&b.input', 'darwin')).toEqual(['rm', '-f', '/tmp/a&b.input'])
  })
})

describe('開発用の本体の上書きは、環境変数だけでは効かない(レビュー #47)', () => {
  test('プラグインのフォルダに印のファイルが無ければ、SUKOSHI_TAKO_DEV=1 と絶対パスがあっても使わない', () => {
    // 環境変数は、開いたリポジトリの設定から入りうる。印のファイルは、その人が自分で置かないと存在しない
    expect(resolveEngineOverride('/opt/dev/ChameleonPane', '1', 'darwin', false)).toBe(null)
    expect(resolveEngineOverride('fake', '1', 'darwin', false)).toBe(null)
    expect(resolveEngineOverride('C:\\dev\\engine.exe', '1', 'win32-x64', false)).toBe(null)
    expect(resolveEngineOverride('/opt/dev/ChameleonPane', '1', 'darwin', undefined)).toBe(null)
  })

  test('印のファイルがあり、SUKOSHI_TAKO_DEV=1 で、絶対パスのときだけ使う', () => {
    expect(resolveEngineOverride('/opt/dev/ChameleonPane', '1', 'darwin', true)).toBe('/opt/dev/ChameleonPane')
    expect(resolveEngineOverride('fake', '1', 'darwin', true)).toBe('fake')
    expect(resolveEngineOverride('/opt/dev/ChameleonPane', undefined, 'darwin', true)).toBe(null)
    expect(resolveEngineOverride('./evil', '1', 'darwin', true)).toBe(null)
  })

  test('印のファイルの場所は、プラグインのフォルダの中', () => {
    expect(devMarkerPath('/plugins/cache/x/tako/0.0.5')).toBe('/plugins/cache/x/tako/0.0.5/dev/allow-local-engine')
  })
})
