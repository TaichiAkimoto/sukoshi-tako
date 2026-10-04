// sukoshi-tako: Claude が作業している間、ペインで「すこしタコ」を遊べるようにする。
// 作業が終わるか、Claude があなたを必要としたら、すぐに戻す。

import {
  DROP_IN_DELAY_MS,
  canShowPixels,
  checksumMatches,
  idlePointer,
  initialState,
  inputFileText,
  inputPathFor,
  isPlayingPhase,
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
} from './logic.js'

const PANE = 'sukoshi-tako'
const TITLE = 'すこしタコ'
const WIDTH = 640
const HEIGHT = 360
// 遊んでいない間もエンジンは止めずに待たせる。これだけ離れたら終了させる
const AWAY_STOP_MS = 5 * 60 * 1000

const NEEDS_TERMINAL = 'すこしタコは Ghostty か kitty のターミナルで遊べます。'

// 出し入れの状態(logic.js の reduce が進める)
let state = initialState()
let timer = null
let awayTimer = null

// 動いている子プロセスの出力、いちばん新しいフレーム、入力ファイルのパス
let engine = null
let frame = null
let inputPath = null
let isStarting = false
// 進行中のゲーム本体の取得と、ペインに出すその進み具合
let download = null
let downloadStatus = null
// エンジンが伝えてきた場面・コース一覧・状態表示
let scene = 'starting'
let sceneDetail = ''
let stages = []
let hud = ''
let failure = null
// ペインから受けた入力と、メニューで押した単発の操作
let keys = []
let pointer = idlePointer()
let events = []
let eventSeq = 0
// メニューで先に選んだ「探す / 隠れる」
let menuMode = null
// このターミナルで絵が出せるか。最初の起動時に調べる
let hasPixels = null
// SUKOSHI_TAKO_DEBUG=1 のとき、ターミナルから届いたままのキー名と、押下中のキーを画面に出す
let isDebug = false
let lastKey = ''

function cancelTimer() {
  timer?.cancel()
  timer = null
}

async function writeInput($) {
  if (!inputPath) return
  await $.fs.write(inputPath, inputFileText({ isPlaying: isPlayingPhase(state.phase), keys, pointer, events }))
}

async function sendEvent($, name) {
  eventSeq += 1
  events = pushEvent(events, eventSeq, name)
  await writeInput($)
}

// logic.js の reduce を 1 歩進め、出てきた副作用を順に実行する
async function dispatch($, action) {
  const { state: next, effects } = reduce(state, action)
  state = next
  for (const effect of effects) {
    switch (effect) {
      case 'armDropIn':
        cancelTimer()
        timer = $.clock.after(DROP_IN_DELAY_MS, () => void dispatch($, { type: 'dropInDue' }))
        break
      case 'cancelTimer':
        cancelTimer()
        break
      case 'open': {
        const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
        // 置けなかったペインを待たせておくと、ずっと後で急に出てしまう
        if (!opened.isPlaced) await $.ui.close({ id: PANE })
        await dispatch($, { type: 'opened', isPlaced: opened.isPlaced })
        if (opened.isPlaced) await startPlaying($)
        break
      }
      case 'close':
        await $.ui.close({ id: PANE })
        break
      case 'startCountdown':
        cancelTimer()
        timer = $.clock.every(1000, () => void dispatch($, { type: 'countdownTick' }))
        break
      case 'redraw':
        $.ui.invalidate('ui.render')
        break
    }
  }
  await writeInput($)
}

async function startPlaying($) {
  awayTimer?.cancel()
  awayTimer = null
  if (engine) await writeInput($)
  // 取得や起動の途中でもう一度呼ばれても、二重には起動しない
  else if (!isStarting) void runEngine($)
}

// ペインが閉じた。エンジンは休ませ、しばらく戻らなければ止める
async function goAway($) {
  frame = null
  keys = []
  pointer = idlePointer()
  if (!engine) return
  await writeInput($)
  awayTimer?.cancel()
  awayTimer = $.clock.after(AWAY_STOP_MS, () => void stopEngine())
}

async function stopEngine() {
  awayTimer?.cancel()
  awayTimer = null
  // ループを抜けると子プロセスが止まる
  if (engine) await engine.return()
}

async function checkPixels($) {
  if (hasPixels !== null) return hasPixels
  hasPixels = canShowPixels({
    termProgram: await $.env.get('TERM_PROGRAM'),
    term: await $.env.get('TERM'),
    kittyWindowId: await $.env.get('KITTY_WINDOW_ID'),
  })
  return hasPixels
}

function enginePath(root) {
  return root + '/dist/sukoshi-tako-engine/ChameleonPane'
}

// プラグインの版ごとに、その版用のゲーム本体を 1 回だけ取得する
function ensureEngine($) {
  download ??= downloadEngine($).finally(() => {
    download = null
  })
  return download
}

async function downloadEngine($) {
  const root = $.plugin.root
  const showStatus = (text) => {
    downloadStatus = text
    $.ui.invalidate('ui.render')
  }
  const manifest = parseEngineManifest(await $.fs.read(root + '/engine.json').catch(() => ''))
  if (!manifest) throw new Error('engine.json が読めません。')
  // 展開済みで、engine.json と同じものなら取り直さない
  const marker = root + '/dist/engine.sha256'
  if ((await $.fs.exists(enginePath(root))) && (await $.fs.exists(marker))) {
    if ((await $.fs.read(marker)).trim() === manifest.sha256) return
  }
  const system = (await $.process.run(['uname', '-s'])).stdout.trim()
  if (system !== 'Darwin') throw new Error('いまは macOS だけで遊べます。')

  const archive = root + '/engine.tar.gz'
  // 取得元の上書きは開発用。どこから取っても、下の照合を通らなければ実行しない
  const url = (await $.env.get('SUKOSHI_TAKO_ENGINE_URL')) ?? manifest.url
  showStatus('ゲーム本体を取得しています(約 7 MB)…')
  const fetched = await $.process.run(['curl', '-fsSL', '--retry', '2', '-o', archive, url], { timeoutMs: 10 * 60 * 1000 })
  if (fetched.exitCode !== 0) throw new Error('ゲーム本体を取得できませんでした。')
  const sum = await $.process.run(['shasum', '-a', '256', archive])
  if (sum.exitCode !== 0 || !checksumMatches(sum.stdout, manifest.sha256)) {
    await $.process.run(['rm', '-f', archive])
    throw new Error('取得したファイルが想定と違うため、実行しません。')
  }
  await $.process.run(['rm', '-rf', root + '/dist/sukoshi-tako-engine'])
  await $.process.run(['mkdir', '-p', root + '/dist'])
  const unpacked = await $.process.run(['tar', '-xzf', archive, '-C', root + '/dist'])
  await $.process.run(['rm', '-f', archive])
  if (unpacked.exitCode !== 0) throw new Error('取得したファイルを展開できませんでした。')
  await $.fs.write(marker, manifest.sha256 + '\n')
  showStatus(null)
}

// 開発中は SUKOSHI_TAKO_ENGINE でローカルのビルドを指す("fake" なら同梱の偽エンジン)。
// SHA-256 の照合を迂回できてしまうので、SUKOSHI_TAKO_DEV=1 の許可があり、絶対パスのときだけ使う
// (それ以外の指定は黙って無視し、通常どおり取得して照合する)。
async function engineRequest($, id) {
  const root = $.plugin.root
  const override = resolveEngineOverride(
    await $.env.get('SUKOSHI_TAKO_ENGINE'),
    await $.env.get('SUKOSHI_TAKO_DEV'),
  )
  const env = {
    // macOS の共有メモリ名は 30 文字まで: "/tk" + 4 文字 + "-" + 連番
    SUKOSHI_TAKO_FRAMES: '/tk' + id + '-',
    SUKOSHI_TAKO_INPUT: inputPath,
    SUKOSHI_TAKO_WIDTH: String(WIDTH),
    SUKOSHI_TAKO_HEIGHT: String(HEIGHT),
  }
  if (override === 'fake') {
    return { argv: ['python3', '-u', root + '/dev/fake_engine.py'], env }
  }
  if (override) {
    if (!(await $.fs.exists(override))) throw new Error('SUKOSHI_TAKO_ENGINE の先にファイルがありません。')
    // 手元のビルドは、隣のフレームワークを自分では見つけられない
    const folder = override.slice(0, override.lastIndexOf('/'))
    return { argv: [override], env: { ...env, DYLD_FRAMEWORK_PATH: folder + ':' + folder + '/PackageFrameworks' } }
  }
  await ensureEngine($)
  return { argv: [enginePath(root)], env }
}

async function runEngine($) {
  // await の前に立てる。待っている間にもう一度呼ばれても、二重には起動しない
  isStarting = true
  const id = Math.random().toString(36).slice(2, 6)
  let request
  try {
    inputPath = inputPathFor(await $.env.get('TMPDIR'), id)
    scene = 'starting'
    failure = null
    // 前のエンジンの時代に溜まった単発操作・キー・ボタンは、新しいエンジンに渡さない
    ;({ keys, pointer, events } = newEngineSession())
    request = await engineRequest($, id)
  } catch (error) {
    inputPath = null
    scene = 'error'
    failure = error.message
    downloadStatus = null
    $.ui.invalidate('ui.render')
    return
  } finally {
    isStarting = false
  }
  await writeInput($)
  engine = $.process.spawn(request)
  let pending = ''
  try {
    for await (const { stream, text } of engine) {
      if (stream !== 'stdout') continue
      const split = splitLines(pending, text)
      pending = split.pending
      for (const line of split.lines) handleEngineLine($, parseEngineLine(line))
    }
  } catch (error) {
    $.ui.log('すこしタコを起動できませんでした: ' + error, { to: 'debug' })
    failure = 'ゲームを起動できませんでした。'
  } finally {
    // 入力ファイルを /tmp に残さない
    const path = inputPath
    engine = null
    frame = null
    inputPath = null
    if (path) await $.process.run(['rm', '-f', path]).catch(() => {})
  }
  // 遊んでいる最中に終わったなら、エンジンが落ちたか自分で終了した
  if (isPlayingPhase(state.phase)) {
    scene = 'error'
    failure = failure ?? 'ゲームが終了しました。'
    $.ui.invalidate('ui.render')
  }
}

function handleEngineLine($, message) {
  if (!message) return
  switch (message.type) {
    case 'frame': {
      const isFirst = frame === null
      frame = message.name
      if (isFirst) $.ui.invalidate('ui.render')
      else $.ui.blit({ requestId: PANE, key: 'view', source: shmSource(frame) }).catch(() => {})
      break
    }
    case 'hud':
      if (message.text === hud) break
      hud = message.text
      $.ui.invalidate('ui.render')
      break
    case 'state':
      scene = message.state
      sceneDetail = message.detail
      // 場面が変わったら、前の場面の絵は捨てる(次のフレームで描き直す)
      if (scene !== 'hide' && scene !== 'seek') {
        frame = null
        // 入力部品も消えるので、押しっぱなしのまま残さない(離した扱いにして伝える)
        keys = []
        pointer = releasedPointer(pointer)
        void writeInput($)
      }
      if (scene === 'menu') menuMode = null
      $.ui.invalidate('ui.render')
      break
    case 'stages':
      stages = message.stages
      $.ui.invalidate('ui.render')
      break
    case 'fatal':
      scene = 'error'
      failure = message.reason
      $.ui.invalidate('ui.render')
      break
  }
}

function shmSource(name) {
  return { shm: name, format: 'rgb', width: WIDTH, height: HEIGHT }
}

const HELP = {
  seek: '十字キーか WASD 移動 · ドラッグか IJKL で狙う · クリックか Space で撃つ(押し続けで連射)· R/F 上下 · C 背後 · V 距離 · Enter さがし終わり',
  hide: '十字キーか WASD 移動 · 右ドラッグか IJKL で視点 · 左ドラッグで塗る · 1 色を拾う · 2 ブラシ · 3 ポーズ · 4 うつす · 5 全身にうつす · Q/E 体の向き · R/F 上下 · Enter ここに隠れる',
}

function drawMenu($, { Box, Text, Button }) {
  if (menuMode === null) {
    return Box({
      flexDirection: 'column',
      gap: 1,
      children: [
        Text({ bold: true, children: ['全世界モード'] }),
        Button({ key: 'seek', label: '誰かを探しに行く', hotkey: '1', autoFocus: true, onPress: () => chooseMode($, 'world_seek') }),
        Button({ key: 'hide', label: '世界に隠れる', hotkey: '2', onPress: () => chooseMode($, 'world_hide') }),
      ],
    })
  }
  return Box({
    flexDirection: 'column',
    gap: 1,
    children: [
      Text({ bold: true, children: [menuMode === 'world_seek' ? 'どのコースを探しますか' : 'どのコースで隠れますか'] }),
      ...stageButtonProps(stages).map((props, index) =>
        Button({ ...props, onPress: () => chooseStage($, stages[index].id) }),
      ),
      Button({ key: 'back', label: '戻る', hotkey: '0', onPress: () => chooseMode($, null) }),
    ],
  })
}

function chooseMode($, mode) {
  menuMode = mode
  $.ui.invalidate('ui.render')
}

async function chooseStage($, stageId) {
  // エンジンは番号順に処理する: どちらで遊ぶか → コース → 決定
  eventSeq += 1
  events = pushEvent(events, eventSeq, menuMode)
  eventSeq += 1
  events = pushEvent(events, eventSeq, 'stage:' + stageId)
  await sendEvent($, 'confirm_stage')
}

function drawGame($, e, { Box, Text, Image, Client }) {
  if (!frame) return Text({ children: ['読み込んでいます…'] })
  const columns = Math.min(255, e.props.bodyColumns)
  const rows = rowsFor(columns, WIDTH, HEIGHT)
  const status =
    state.phase === 'countdown'
      ? Text({ bold: true, children: ['Claude の作業が終わりました · あと ' + state.countdown] })
      : Text({ dimColor: true, children: [HELP[scene] ?? ''] })
  return Box({
    flexDirection: 'column',
    children: [
      Image({ key: 'view', source: shmSource(frame), columns, rows, alt: NEEDS_TERMINAL }),
      // 絵の上に重ねて、クリックとキーをゲームへ渡す
      Box({
        position: 'absolute',
        top: 0,
        left: 0,
        children: [Client({ key: 'input', module: './input.js', width: columns, height: rows })],
      }),
      ...(hud ? [Text({ children: [hud] })] : []),
      ...(isDebug
        ? [Text({ dimColor: true, children: ['届いたキー: ' + JSON.stringify(lastKey) + ' · 押下中: ' + keys.join(' ')] })]
        : []),
      status,
    ],
  })
}

function drawPane($, e) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  if (e.surface !== 'terminal' || hasPixels === false) return Text({ children: [NEEDS_TERMINAL] })
  switch (scene) {
    case 'starting':
    case 'loading':
      return Text({ children: [downloadStatus ?? '読み込んでいます…'] })
    case 'menu':
      return drawMenu($, elements)
    case 'hide':
    case 'seek':
      return drawGame($, e, elements)
    case 'published':
    case 'result':
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: [
          Text({ bold: true, children: [scene === 'published' ? '世界に隠れました' : '結果'] }),
          ...(sceneDetail ? [Text({ children: [sceneDetail] })] : []),
          Button({ key: 'hub', label: 'ハブへ戻る', hotkey: '1', autoFocus: true, onPress: () => sendEvent($, 'back_to_hub') }),
        ],
      })
    default:
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: [
          Text({ children: [failure ?? 'うまく動いていません。'] }),
          Button({ key: 'retry', label: 'もう一度', hotkey: '1', autoFocus: true, onPress: () => retry($) }),
        ],
      })
  }
}

async function retry($) {
  if (engine) await sendEvent($, 'retry')
  else void runEngine($)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const isOn = (await $.store.get('isOn')) === true
    state = { ...initialState(), isOn }
    isDebug = (await $.env.get('SUKOSHI_TAKO_DEBUG')) === '1'
    await $.command.register({
      name: 'tako',
      description: 'Claude の作業中にすこしタコを遊ぶ',
      argumentHint: '[off]',
    })
    return next(e)
  })

  on('command.run', { command: 'tako' }, async ($, e) => {
    if (e.args.trim() === 'off') {
      await $.store.set('isOn', false)
      await dispatch($, { type: 'setOn', isOn: false })
      await stopEngine()
      return { text: 'すこしタコをオフにしました。' }
    }
    await $.store.set('isOn', true)
    await dispatch($, { type: 'setOn', isOn: true })
    if (!(await checkPixels($))) return { text: NEEDS_TERMINAL }
    // 自分で開いたペインは、狭いターミナルでも置かれる
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    await dispatch($, { type: 'openedByPerson' })
    await startPlaying($)
    return {}
  })

  on('turn.start', async ($, e, next) => {
    if (state.isOn && (await checkPixels($))) await dispatch($, { type: 'turnStart' })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // サブエージェントの完了では戻さない
    if (e.agentId) return next(e)
    await dispatch($, { type: 'turnComplete', isAborted: e.isAborted === true })
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const result = await next(e)
    // 確認が人ではなく分類器に回ることもあるが、本物の確認を見逃すほうが高くつく
    if (e.tool_use_id && result.decision === 'ask') await dispatch($, { type: 'needsYou' })
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion') await dispatch($, { type: 'needsYou' })
    const result = await next(e)
    await dispatch($, { type: 'toolRan' })
    return result
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    await dispatch($, { type: 'paneClosed', byPerson: e.origin?.kind === 'person' })
    await goAway($)
    return next(e)
  })

  on('ui.message', async ($, e) => {
    if (e.element !== 'input') return {}
    keys = Array.isArray(e.data.keys) ? e.data.keys : []
    pointer = { ...idlePointer(), ...e.data.pointer }
    if (isDebug && e.data.lastKey !== lastKey) {
      lastKey = e.data.lastKey
      $.ui.invalidate('ui.render')
    }
    await writeInput($)
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (state.phase !== 'offered') return next(e)
    const { Box, Button } = $.ui.resolve(e)
    // 他のプラグインが帯に出しているものは残す
    const others = await next(e)
    return Box({
      flexDirection: 'column',
      children: [
        Button({
          key: 'play',
          label: 'Claude の作業中にすこしタコを遊ぶ',
          hotkey: '1',
          plain: true,
          onPress: async () => {
            await $.ui.open({ id: PANE, title: TITLE, focus: true })
            await dispatch($, { type: 'openedByPerson' })
            await startPlaying($)
          },
        }),
        ...(others ? [others] : []),
      ],
    })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    return drawPane($, e)
  })
}
