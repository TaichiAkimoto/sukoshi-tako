// sukoshi-tako: Claude が作業している間、ペインで「すこしタコ」を遊べるようにする。
// 作業が終わるか、Claude があなたを必要としたら、すぐに戻す。

import {
  classifyEngineEnd,
  commandAction,
  commandNames,
  devEngineRequest,
  DROP_IN_DELAY_MS,
  canShowPixels,
  checksumMatches,
  engineEndAction,
  fetchPlan,
  idlePointer,
  initialState,
  inputFileText,
  inputPathFor,
  isStartStillWanted,
  isPlayingPhase,
  launchRequest,
  NEEDS_TERMINAL,
  newEngineSession,
  PANE_HEIGHT,
  PANE_WIDTH,
  paneOpenArgs,
  removeFileArgv,
  paneView,
  parseEngineAssets,
  parseEngineLine,
  platformKey,
  playMode,
  pushEvent,
  reduce,
  releasedPointer,
  resolveEngineAsset,
  resolveEngineOverride,
  devMarkerPath,
  splitLines,
  surfaceOrGuess,
  unavailableText,
} from './logic.js'

const PANE = 'sukoshi-tako'
// plugin.json の name。ファイルで宣言したコマンドは <この名前>:play、<この名前>:off で届く
const PLUGIN_NAME = 'tako'
const TITLE = 'すこしタコ'
// 遊んでいない間もエンジンは止めずに待たせる。これだけ離れたら終了させる
const AWAY_STOP_MS = 5 * 60 * 1000

// 出し入れの状態(logic.js の reduce が進める)
let state = initialState()
let timer = null
let awayTimer = null

// 動いている子プロセスの出力、いちばん新しいフレーム、入力ファイルのパス
let engine = null
let frame = null
let inputPath = null
let isStarting = false
// オフにした・ペインを閉じたら進める。準備の途中だった起動は、進んでいたら取りやめる
let startToken = 0
// 進行中のゲーム本体の取得と、ペインに出すその進み具合
let download = null
let downloadStatus = null
// エンジンが伝えてきた場面・コース一覧・状態表示
let scene = 'starting'
let sceneDetail = ''
let stages = []
let hud = ''
let failure = null
// failure の種類。'noBuild' = この OS の本体がまだ無い(ウィンドウの話をしない)
let failureKind = null
// プラグインが本体を止めた(Windows では、止めた子も終了コードで返るので、自分の記録で見分ける)
let stopRequested = false
// ペインから受けた入力と、メニューで押した単発の操作
let keys = []
let pointer = idlePointer()
let events = []
let eventSeq = 0
// メニューで先に選んだ「探す / 隠れる」
let menuMode = null
// このターミナルで絵が出せるか。最初の起動時に調べる
let hasPixels = null
// このセッションの OS と CPU。1 回だけ調べる
let platformCache = null
let isPlatformKnown = false
// /tako:play の時点で表示先が分からなかったので、ペインを描くときに始める
let wantsPlay = false
// SUKOSHI_TAKO_DEBUG=1 のとき、ターミナルから届いたままのキー名と、押下中のキーを画面に出す
let isDebug = false
let lastKey = ''

function cancelTimer() {
  timer?.cancel()
  timer = null
}

async function writeInput($) {
  if (!inputPath) return
  await $.fs.write(
    inputPath,
    inputFileText({ isPlaying: isPlayingPhase(state.phase), keys, pointer, events, mode: state.mode }),
  )
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
        const opened = await $.ui.open(paneOpenArgs(PANE, TITLE))
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
  // 取得や起動の準備の途中で閉じられた。見る人がいないので、準備が終わっても起動しない
  if (!engine && isStarting) startToken += 1
  if (!engine) return
  await writeInput($)
  // ウィンドウ方式: ゲームは自分のウィンドウで動き続ける。ペインを閉じても止めない
  // (終わらせるのは、ゲームのウィンドウを閉じる・「やめる」・/tako:off)
  if (state.mode === 'window') return
  awayTimer?.cancel()
  awayTimer = $.clock.after(AWAY_STOP_MS, () => void stopEngine())
}

async function stopEngine() {
  awayTimer?.cancel()
  awayTimer = null
  startToken += 1
  // ループを抜けると子プロセスが止まる
  if (engine) {
    stopRequested = true
    await engine.return()
  }
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

// このセッションの OS と CPU。1 回だけ調べる(uname は毎回呼ばない)
async function platformFor($) {
  if (!isPlatformKnown) {
    platformCache = await detectPlatform($)
    // 調べるのに失敗した(null)ときは覚えない。次にもう一度調べる
    isPlatformKnown = platformCache !== null
  }
  return platformCache
}

// OS の判定。Windows は uname が無いので環境変数を先に見る
async function detectPlatform($) {
  const envOS = await $.env.get('OS')
  if (envOS === 'Windows_NT') {
    return platformKey({ envOS, processorArchitecture: await $.env.get('PROCESSOR_ARCHITECTURE') })
  }
  try {
    return platformKey({
      unameS: (await $.process.run(['uname', '-s'])).stdout.trim(),
      unameM: (await $.process.run(['uname', '-m'])).stdout.trim(),
    })
  } catch {
    return null
  }
}

// プラグインの版ごとに、その版用のゲーム本体を 1 回だけ取得する。
// 戻り値は { platform, asset, plan }。展開済みで engine.json と同じなら取り直さない。
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
  const platform = await platformFor($)
  const assets = parseEngineAssets(await $.fs.read(root + '/engine.json').catch(() => ''))
  // この OS の本体が engine.json にまだ無いときも、落ちずに理由の分かる案内を出す
  const found = resolveEngineAsset(assets, platform)
  if (!found.ok) throw Object.assign(new Error(found.text), { failureKind: found.kind })
  const asset = found.asset
  // 取得元の上書きは開発用。どこから取っても、下の照合を通らなければ実行しない
  const url = (await $.env.get('SUKOSHI_TAKO_ENGINE_URL')) ?? asset.url
  const plan = fetchPlan({ platform, root, url })
  if (!plan) throw new Error('このフォルダの場所では、ゲーム本体を取得できません。')
  // 展開済みで、engine.json と同じものなら取り直さない
  if ((await $.fs.exists(plan.engineDir)) && (await $.fs.exists(plan.marker))) {
    if ((await $.fs.read(plan.marker)).trim() === asset.sha256) return { platform, asset, plan }
  }
  showStatus('ゲーム本体を取得しています(約 7 MB)…')
  const fetched = await $.process.run(plan.download, { timeoutMs: 10 * 60 * 1000 })
  if (fetched.exitCode !== 0) throw new Error('ゲーム本体を取得できませんでした。')
  const sum = await $.process.run(plan.hash)
  if (sum.exitCode !== 0 || !checksumMatches(sum.stdout, asset.sha256)) {
    await $.process.run(plan.removeArchive)
    throw new Error('取得したファイルが想定と違うため、実行しません。')
  }
  // 展開が途中で失敗しても「展開済み」と見なされないよう、印を先に無効にする
  if (await $.fs.exists(plan.marker)) await $.fs.write(plan.marker, '')
  await $.process.run(plan.removeOld)
  await $.process.run(plan.makeDist)
  const unpacked = await $.process.run(plan.unpack)
  await $.process.run(plan.removeArchive)
  if (unpacked.exitCode !== 0) throw new Error('取得したファイルを展開できませんでした。')
  await $.fs.write(plan.marker, asset.sha256 + '\n')
  showStatus(null)
  return { platform, asset, plan }
}

// 開発中は SUKOSHI_TAKO_ENGINE でローカルのビルドを指す("fake" なら同梱の偽エンジン)。
// SHA-256 の照合を迂回できてしまうので、SUKOSHI_TAKO_DEV=1 の許可があり、絶対パスのときだけ使う
// (それ以外の指定は黙って無視し、通常どおり取得して照合する)。
async function engineRequest($, id) {
  const root = $.plugin.root
  const mode = state.mode === 'window' ? 'window' : 'pane'
  const platform = await platformFor($)
  const override = resolveEngineOverride(
    await $.env.get('SUKOSHI_TAKO_ENGINE'),
    await $.env.get('SUKOSHI_TAKO_DEV'),
    platform,
    // 印のファイルが、このプラグインのフォルダの中にあるときだけ(環境変数だけでは効かせない)
    await $.fs.exists(devMarkerPath(root)).catch(() => false),
  )
  if (override) {
    if (override !== 'fake' && !(await $.fs.exists(override))) {
      throw new Error('SUKOSHI_TAKO_ENGINE の先にファイルがありません。')
    }
    return devEngineRequest({ override, platform, mode, root, id, inputPath })
  }
  // 本体は、取得のときに照合した配布物だけを起動する。素材のパックは展開先で渡す
  const ensured = await ensureEngine($)
  const request = launchRequest({
    platform: ensured.platform,
    mode,
    root,
    asset: ensured.asset,
    engineDir: ensured.plan.engineDir,
    id,
    inputPath,
  })
  if (!request) throw new Error('ゲーム本体の場所が分かりません。')
  return request
}

async function runEngine($) {
  // await の前に立てる。待っている間にもう一度呼ばれても、二重には起動しない
  isStarting = true
  const id = Math.random().toString(36).slice(2, 6)
  const token = startToken
  let request
  let platform = null
  try {
    platform = await platformFor($)
    const tmp = platform === 'win32-x64' ? await $.env.get('TEMP') : await $.env.get('TMPDIR')
    inputPath = inputPathFor(tmp, id, platform)
    if (!inputPath) throw new Error('一時フォルダの場所が分かりません。')
    scene = 'starting'
    failure = null
    failureKind = null
    // 前のエンジンの時代に溜まった単発操作・キー・ボタンは、新しいエンジンに渡さない
    ;({ keys, pointer, events } = newEngineSession())
    request = await engineRequest($, id)
  } catch (error) {
    inputPath = null
    scene = 'error'
    failure = error.message
    failureKind = error.failureKind ?? null
    downloadStatus = null
    $.ui.invalidate('ui.render')
    return
  } finally {
    isStarting = false
  }
  // 準備の間にオフにされた・ペインを閉じられたなら、起動しない
  if (!isStartStillWanted(token, startToken)) {
    inputPath = null
    scene = 'menu'
    downloadStatus = null
    return
  }
  await writeInput($)
  stopRequested = false
  engine = $.process.spawn(request)
  let pending = ''
  // 終わり方({ code, signal })。止められたときは無い
  let result
  try {
    for (;;) {
      const step = await engine.next()
      if (step.done) {
        result = step.value
        break
      }
      const { stream, text } = step.value
      if (stream !== 'stdout') continue
      const split = splitLines(pending, text)
      pending = split.pending
      for (const line of split.lines) handleEngineLine($, parseEngineLine(line))
    }
  } catch (error) {
    $.ui.log('すこしタコを起動できませんでした: ' + error, { to: 'debug' })
    failure = 'ゲームを起動できませんでした。'
  } finally {
    // 流し読みが途中で失敗しても、子を残さない(for await なら自動で呼ばれる後始末を、手動のループでも行う)
    await engine?.return?.().catch(() => {})
    // 入力ファイルを /tmp に残さない
    const path = inputPath
    engine = null
    frame = null
    inputPath = null
    const removal = path ? removeFileArgv(path, platform) : null
    if (removal) await $.process.run(removal).catch(() => {})
  }
  // 人が閉じた・プラグインが止めた・落ちた、の見分け(Windows では止めた子も終了コードで返る)。
  // 画面の扱いは Mac と同じで、OS によらない。見分けの結果は診断のログにだけ残す
  const kind = classifyEngineEnd({ result, stopRequested, hasFatal: failureKind === 'fatal' })
  $.ui.log('すこしタコの本体が終わりました: ' + kind + ' ' + JSON.stringify(result ?? null), { to: 'debug' })
  const action = engineEndAction({ mode: state.mode, hasFailure: Boolean(failure), isPlaying: isPlayingPhase(state.phase) })
  if (action === 'closePane') {
    // ウィンドウ方式で、ゲームのウィンドウを人が閉じた。失敗ではないので、ペインも静かに閉じる
    scene = 'starting'
    await $.ui.close({ id: PANE }).catch(() => {})
  } else if (action === 'markEnded') {
    // 遊んでいる最中に終わったなら、エンジンが落ちたか自分で終了した
    scene = 'error'
    failure = failure ?? 'ゲームが終了しました。'
    $.ui.invalidate('ui.render')
  }
}

function handleEngineLine($, message) {
  if (!message) return
  switch (message.type) {
    case 'frame': {
      // ウィンドウ方式では絵は本体のウィンドウ。ペインには出さない
      if (state.mode === 'window') break
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
      failureKind = 'fatal'
      $.ui.invalidate('ui.render')
      break
  }
}

// 表示先と OS で、遊び方を決める(ペイン / ウィンドウ / 遊べない)
async function modeFor($, surface) {
  return playMode({
    surface,
    hasPixels: await checkPixels($),
    platform: await platformFor($),
  })
}

// いまのセッションが描いている表示先から、遊び方を決め直す。
// 起動直後やコマンドの時点では、表示先がまだ付いていないことがある。そのときは null を返し、
// 遊び方は変えない(ペインを描くときに drawPane が決める)。
async function refreshMode($, fallbackSurface) {
  let surface = fallbackSurface ?? null
  try {
    const surfaces = await $.session.surfaces()
    if (surfaces.length > 0) surface = surfaces[0]
  } catch {
    // 表示先が読めないときは、渡されたものだけで決める
  }
  surface = surfaceOrGuess(surface, await checkPixels($))
  if (surface === null) return null
  const mode = await modeFor($, surface)
  if (mode !== state.mode) await dispatch($, { type: 'setMode', mode })
  return mode
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

function pressOption($, option) {
  if (option.action === 'stage') void chooseStage($, option.stageId)
  else if (option.action === 'mode') chooseMode($, option.mode)
}

function pressButton($, button) {
  if (button.action === 'event') void sendEvent($, button.event)
  else if (button.action === 'close') {
    // 自分でやめた。ゲームのウィンドウを残さない(残すと「Claude が呼んでいます」のまま 5 分居座る)
    void stopEngine()
    void $.ui.close({ id: PANE })
  }
}

// autoFocus は「true か、付けない」のどちらかでなければ描画が拒否される
function buttonProps(button) {
  return {
    key: button.key,
    label: button.label,
    hotkey: button.hotkey,
    ...(button.autoFocus ? { autoFocus: true } : {}),
  }
}

function shmSource(name) {
  return { shm: name, format: 'rgb', width: PANE_WIDTH, height: PANE_HEIGHT }
}

// paneView の平たい記述を、その表示先の要素に写す
function renderView($, elements, view) {
  const { Box, Text, Button, Image, Client } = elements
  switch (view.kind) {
    case 'message':
      return Text({ children: [view.text] })
    case 'menu':
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: [
          Text({ bold: true, children: [view.title] }),
          ...view.options.map((option) => Button({ ...buttonProps(option), onPress: () => pressOption($, option) })),
        ],
      })
    case 'game':
      return Box({
        flexDirection: 'column',
        children: [
          Image({ key: 'view', source: shmSource(frame), columns: view.image.columns, rows: view.image.rows, alt: NEEDS_TERMINAL }),
          // 絵の上に重ねて、クリックとキーをゲームへ渡す
          Box({
            position: 'absolute',
            top: 0,
            left: 0,
            children: [Client({ key: 'input', module: './input.js', width: view.image.columns, height: view.image.rows })],
          }),
          // 操作の説明は絵のすぐ下。数えている間は、残りをそこに出す
          ...(view.status
            ? [Text({ bold: true, children: [view.status.text] })]
            : view.help.map((line, index) => Text({ key: 'help' + index, dimColor: true, children: [line] }))),
          ...(view.hud ? [Text({ children: [view.hud] })] : []),
          ...(view.debug ? [Text({ dimColor: true, children: [view.debug] })] : []),
        ],
      })
    case 'windowGame':
      // ウィンドウ方式のペイン: 絵も入力部品も出さず、案内とボタンだけ
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: [
          Text({ children: [view.note] }),
          ...(view.hud ? [Text({ children: [view.hud] })] : []),
          Text({ dimColor: true, children: [view.help] }),
          ...view.keys.map((line, index) => Text({ key: 'keys' + index, dimColor: true, children: [line] })),
          ...view.buttons.map((button) => Button({ ...buttonProps(button), onPress: () => pressButton($, button) })),
        ],
      })
    case 'outcome':
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: [
          Text({ bold: true, children: [view.title] }),
          ...(view.detail ? [Text({ children: [view.detail] })] : []),
          Button({ ...buttonProps(view.button), onPress: () => sendEvent($, 'back_to_hub') }),
        ],
      })
    case 'error':
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: [
          Text({ children: [view.text] }),
          ...(view.guidance ? [Text({ children: [view.guidance] })] : []),
          Button({ ...buttonProps(view.button), onPress: () => retry($) }),
        ],
      })
    default:
      return Text({ children: [view.text ?? NEEDS_TERMINAL] })
  }
}

async function drawPane($, e) {
  const elements = $.ui.resolve(e)
  const mode = await modeFor($, e.surface)
  if (mode !== state.mode) await dispatch($, { type: 'setMode', mode })
  // /tako:play の時点で表示先が分からなかった分は、ここで始める
  if (wantsPlay) {
    wantsPlay = false
    if (mode !== 'none') {
      await dispatch($, { type: 'openedByPerson' })
      void startPlaying($)
    }
  }
  const view = paneView(
    {
      ...state,
      platform: await platformFor($),
      scene,
      sceneDetail,
      hud,
      stages,
      menuMode,
      failure,
      failureKind,
      downloadStatus,
      isDebug,
      keys,
      lastKey,
      hasFrame: frame !== null,
      columns: e.props?.bodyColumns,
      rows: e.props?.scroll?.bodyRows,
    },
    mode,
  )
  return renderView($, elements, view)
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
    // 表示先が分かるときは、ここで遊び方を決めておく(デスクトップでは後から付くこともある)
    await refreshMode($, e.surface)
    return next(e)
  })

  for (const name of commandNames(PLUGIN_NAME)) {
    on('command.run', { command: name }, async ($, e) => {
      if (commandAction(name, e.args) === 'off') {
        await $.store.set('isOn', false)
        await dispatch($, { type: 'setOn', isOn: false })
        await stopEngine()
        return { text: 'すこしタコをオフにしました。' }
      }
      await $.store.set('isOn', true)
      await dispatch($, { type: 'setOn', isOn: true })
      // 表示先がいま付いているかを確かめ直す(デスクトップでは起動時に無いことがある)
      const mode = await refreshMode($)
      if (mode === 'none') return { text: unavailableText(await platformFor($)) }
      if (mode === null) {
        // 表示先がまだ分からない(デスクトップアプリなど)。ペインを開き、描くときに決めて始める
        wantsPlay = true
        await $.ui.open(paneOpenArgs(PANE, TITLE))
        return {}
      }
      // 自分で開いたペインは、狭いターミナルでも置かれる
      await $.ui.open(paneOpenArgs(PANE, TITLE))
      await dispatch($, { type: 'openedByPerson' })
      await startPlaying($)
      return {}
    })
  }

  on('turn.start', async ($, e, next) => {
    // ウィンドウ方式では自動で開かない(開くのは /tako:play とペインのボタンだけ)。
    // それでも印は付けておく。止めていたゲームを次の作業で動かすため
    // 表示先が分からないうちは開かない(絵が出せるターミナルは、今までどおり開く)
    const mode = await refreshMode($)
    if (state.isOn && mode !== null && mode !== 'none') await dispatch($, { type: 'turnStart' })
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
    // 帯はターミナルだけのもの。ウィンドウ方式では出さない
    if (state.mode !== 'pane' || state.phase !== 'offered') return next(e)
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
            await $.ui.open(paneOpenArgs(PANE, TITLE))
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
