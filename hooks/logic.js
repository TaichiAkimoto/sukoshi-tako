// sukoshi-tako の、$ に触らない部分。register.js が使い、テストが直接呼ぶ。

export const DROP_IN_DELAY_MS = 2000
export const COUNTDOWN_SECONDS = 3
// 入力ファイルの 3 行目に残す単発操作の数。エンジンは番号で処理済みを見分ける
export const EVENTS_KEPT = 8

// ゲーム画面の大きさ(本体と共有する画素の数)
export const PANE_WIDTH = 640
export const PANE_HEIGHT = 360
// ウィンドウ方式のゲームのウィンドウ(開いた後は人が大きさを変えられる)
export const WINDOW_WIDTH = 1280
export const WINDOW_HEIGHT = 720

export function engineSize(mode) {
  return mode === 'window'
    ? { width: WINDOW_WIDTH, height: WINDOW_HEIGHT }
    : { width: PANE_WIDTH, height: PANE_HEIGHT }
}

// ---- 出し入れの状態機械 ----
//
//   idle       遊んでいない(Claude が作業中かどうかは問わない)
//   waiting    Claude が作業中。待ち時間が過ぎたら入る
//   offered    ターミナルが狭くて自動では開けなかった。帯のボタンで開ける
//   playing    ペインが開いていて遊んでいる
//   countdown  Claude の作業が終わった。数え終わったら閉じる
//   paused     ウィンドウ方式で Claude の番。ペインは開いたまま、本体は止めている

export function initialState() {
  return { phase: 'idle', isOn: false, isTurnRunning: false, isDismissed: false, countdown: 0, mode: 'pane' }
}

// 返すのは次の状態と、register.js が実行する副作用の名前の並び。
//   armDropIn / cancelTimer / open / close / startCountdown / redraw
//
// mode は 'pane'(ペインの中に絵を出す)/ 'window'(本体が別ウィンドウを出す)。
// ウィンドウ方式は自動で開かず、Claude の作業が終わってもペインを閉じない
// (遊んでいるかを 0 にして、本体に一時停止を知らせるだけ)。ペイン方式の動きは変えない。
export function reduce(state, action) {
  const next = { ...state }
  const effects = []
  const canArm = () =>
    next.mode === 'pane' && next.isOn && next.isTurnRunning && !next.isDismissed && next.phase === 'idle'
  const arm = () => {
    if (!canArm()) return
    next.phase = 'waiting'
    effects.push('armDropIn')
  }
  const pullOut = () => {
    effects.push('cancelTimer')
    if (next.phase === 'playing' || next.phase === 'countdown' || next.phase === 'paused') effects.push('close')
    else effects.push('redraw')
    next.phase = 'idle'
  }

  switch (action.type) {
    case 'setMode':
      next.mode = action.mode
      break
    case 'setOn':
      next.isOn = action.isOn
      if (!action.isOn && next.phase !== 'idle') pullOut()
      break
    case 'turnStart':
      next.isTurnRunning = true
      next.isDismissed = false
      if (next.phase === 'countdown') {
        // 続けて次の作業が始まったので、そのまま遊ぶ
        next.phase = 'playing'
        effects.push('cancelTimer', 'redraw')
      } else if (next.mode === 'window' && next.phase === 'paused') {
        // 止めていたゲームを、Claude が続きを始めたらまた動かす
        next.phase = 'playing'
        effects.push('redraw')
      }
      arm()
      break
    case 'dropInDue':
      if (next.phase === 'waiting') effects.push('open')
      break
    case 'opened':
      // 自動で開こうとした結果。置けなければ帯で誘う
      if (next.phase !== 'waiting') break
      next.phase = action.isPlaced ? 'playing' : 'offered'
      effects.push('redraw')
      break
    case 'openedByPerson':
      next.phase = 'playing'
      effects.push('cancelTimer', 'redraw')
      break
    case 'turnComplete':
      next.isTurnRunning = false
      if (next.mode === 'window') {
        // ペインは閉じず、本体も止めない。遊んでいるかを 0 にして一時停止を知らせる
        if (next.phase === 'playing') {
          next.phase = 'paused'
          effects.push('redraw')
        }
      } else if (next.phase === 'waiting' || next.phase === 'offered') {
        pullOut()
      } else if (next.phase === 'playing') {
        if (action.isAborted) {
          pullOut()
        } else {
          next.phase = 'countdown'
          next.countdown = COUNTDOWN_SECONDS
          effects.push('startCountdown', 'redraw')
        }
      }
      break
    case 'countdownTick':
      if (next.phase !== 'countdown') break
      next.countdown -= 1
      if (next.countdown > 0) effects.push('redraw')
      else pullOut()
      break
    case 'needsYou':
      if (next.mode === 'window') {
        // Claude が確認を出す。ペインは閉じずに、遊んでいるかを 0 にする
        if (next.phase === 'playing') {
          next.phase = 'paused'
          effects.push('redraw')
        }
      } else if (next.phase !== 'idle') {
        // プロンプトを見せるために即座に引く
        pullOut()
      }
      break
    case 'toolRan':
      if (next.mode === 'window') {
        // 確認に答えて Claude が続きを始めたら、止めていたゲームをまた動かす
        if (next.phase === 'paused') {
          next.phase = 'playing'
          effects.push('redraw')
        }
      } else {
        // 確認に答えて Claude が続きを始めたら、また入る
        arm()
      }
      break
    case 'paneClosed':
      if (action.byPerson && next.isTurnRunning) next.isDismissed = true
      next.phase = 'idle'
      effects.push('cancelTimer')
      break
  }
  return { state: next, effects }
}

export function isPlayingPhase(phase) {
  return phase === 'playing' || phase === 'countdown'
}

// ---- 絵の大きさ ----

// ターミナルのセルは縦が横の約 2 倍
export function rowsFor(columns, width, height) {
  return Math.max(1, Math.round((columns * height) / width / 2))
}

// ペインに頼む大きさ(頼みであって、置き場所が狭ければ小さくなる)。横に並ぶときは幅、
// 入力欄の上に出るときは高さが効く
export const PANE_WANTS = { columns: 120, rows: 40 }

export function paneOpenArgs(id, title) {
  return { id, title, focus: true, ...PANE_WANTS }
}

// 絵はペインの幅いっぱい。ただし下に出す行(操作の説明と HUD)が隠れない高さまでにする
export function imageCells(bodyColumns, bodyRows, rowsBelow) {
  let columns = Math.min(255, Math.max(0, bodyColumns ?? 0))
  if (Number.isFinite(bodyRows)) {
    const room = Math.max(1, bodyRows - rowsBelow)
    columns = Math.min(columns, Math.floor((room * 2 * PANE_WIDTH) / PANE_HEIGHT))
  }
  return { columns, rows: rowsFor(columns, PANE_WIDTH, PANE_HEIGHT) }
}

// ---- 入力ファイル ----

export function idlePointer() {
  return { isLeftDown: false, isRightDown: false, x: 0, y: 0, leftDowns: 0, leftUps: 0, rightDowns: 0, rightUps: 0 }
}

// エンジンと共有する約束。3 行で、必ず改行で終わる。
// window 方式(本体のウィンドウがキーを直接受ける)では、キーとマウスを載せず、
// 1 行目は遊んでいるかだけ、2 行目は押されていないマウスにする。
export function inputFileText({ isPlaying, keys, pointer, events, mode }) {
  if (mode === 'window') {
    const first = isPlaying ? '1' : '0'
    const second = 'P 0 0 0.0000 0.0000 0 0 0 0'
    const third = ['E', ...events.map((event) => event.id + ':' + event.name)].join(' ')
    return first + '\n' + second + '\n' + third + '\n'
  }
  const p = pointer
  const first = [isPlaying ? '1' : '0', ...(isPlaying ? [...keys].sort() : [])].join(' ')
  const second = [
    'P',
    isPlaying && p.isLeftDown ? 1 : 0,
    isPlaying && p.isRightDown ? 1 : 0,
    clamp01(p.x).toFixed(4),
    clamp01(p.y).toFixed(4),
    p.leftDowns,
    p.leftUps,
    p.rightDowns,
    p.rightUps,
  ].join(' ')
  const third = ['E', ...events.map((event) => event.id + ':' + event.name)].join(' ')
  return first + '\n' + second + '\n' + third + '\n'
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}

// 新しいエンジンを起動するときの、入力の初期状態。
// エンジンは「処理済みの単発操作の番号」を 0 から数え直すので、前のエンジンの時代に溜まった
// 操作(探す・コース・決定)を渡すと、何も選んでいないのに前回のコースが始まる。
export function newEngineSession() {
  return { keys: [], pointer: idlePointer(), events: [] }
}

// 絶対パスかどうか。Windows はドライブ文字(C:\ か C:/)が要る
export function isAbsolutePath(path, platform) {
  if (typeof path !== 'string') return false
  if (platform === 'win32-x64') return /^[A-Za-z]:[\\/]/.test(path)
  return path.startsWith('/')
}

// 入力ファイルの置き場所。ほかのユーザーも書ける /tmp ではなく、ユーザーごとの一時フォルダ
// (macOS の TMPDIR、自分だけが読み書きできる)に置く。絶対パスでなければ /tmp に戻す。
// Windows は %TEMP% の絶対パスが分かったときだけ置く(戻し先の /tmp は無い)。
export function inputPathFor(tmpdir, id, platform) {
  if (platform === 'win32-x64') {
    if (!isAbsolutePath(tmpdir, 'win32-x64')) return null
    return tmpdir.replace(/[\\/]+$/, '') + '\\sukoshi-tako-' + id + '.input'
  }
  const base = typeof tmpdir === 'string' && tmpdir.startsWith('/') ? tmpdir.replace(/\/+$/, '') : '/tmp'
  return base + '/sukoshi-tako-' + id + '.input'
}

// 開発用の SUKOSHI_TAKO_ENGINE。SHA-256 の照合を通らずに任意の実行ファイルを起動できてしまうので、
// SUKOSHI_TAKO_DEV=1 の明示的な許可があり、かつ絶対パス(または fake)のときだけ受け付ける。
export function resolveEngineOverride(override, devFlag, platform) {
  if (devFlag !== '1' || typeof override !== 'string') return null
  if (override === 'fake') return 'fake'
  return isAbsolutePath(override, platform) ? override : null
}

// 場面がゲームでなくなったとき。ペインの入力部品が消えると「離した」が届かず、ゲームは押しっぱなしの
// まま(連射し続ける)になる。押していたボタンに、離した回数を 1 つ足して離した扱いにする。
export function releasedPointer(pointer) {
  return {
    ...pointer,
    isLeftDown: false,
    isRightDown: false,
    leftUps: pointer.leftUps + (pointer.isLeftDown ? 1 : 0),
    rightUps: pointer.rightUps + (pointer.isRightDown ? 1 : 0),
  }
}

export function pushEvent(events, id, name) {
  return [...events, { id, name }].slice(-EVENTS_KEPT)
}

// ---- エンジンの標準出力 ----

// かたまりで届く出力を行に分ける。最後の、まだ改行の来ていない分は持ち越す
export function splitLines(pending, text) {
  const lines = (pending + text).split('\n')
  const rest = lines.pop()
  return { lines, pending: rest }
}

export function parseEngineLine(line) {
  if (!line.startsWith('@')) return null
  const space = line.indexOf(' ')
  const tag = space === -1 ? line : line.slice(0, space)
  const rest = space === -1 ? '' : line.slice(space + 1)
  switch (tag) {
    case '@frame': {
      const name = rest.split(' ')[0]
      return name ? { type: 'frame', name } : null
    }
    case '@hud':
      return { type: 'hud', text: rest }
    case '@state': {
      const [state, ...detail] = rest.split(' ')
      return state ? { type: 'state', state, detail: detail.join(' ') } : null
    }
    case '@stages':
      try {
        const stages = JSON.parse(rest)
        if (!Array.isArray(stages)) return null
        return { type: 'stages', stages: stages.filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string') }
      } catch {
        return null
      }
    case '@fatal':
      return { type: 'fatal', reason: rest }
    default:
      return null
  }
}

// ---- ゲーム本体の取得 ----

// engine.json: この版のプラグインが取りに行くゲーム本体と、その SHA-256。
// 形が違えば null(その場合は何も取りに行かない)。
export function parseEngineManifest(text) {
  try {
    const { version, url, sha256 } = JSON.parse(text)
    if (typeof version !== 'string' || typeof url !== 'string' || typeof sha256 !== 'string') return null
    if (!/^(https|file):\/\//.test(url)) return null
    if (!/^[0-9a-f]{64}$/.test(sha256)) return null
    return { version, url, sha256 }
  } catch {
    return null
  }
}

// 配布物の中の実行ファイルへの相対パス。外へ出る形は受け付けない。
function isEntryPath(value) {
  if (typeof value !== 'string' || value === '') return false
  if (value.startsWith('/') || value.includes('\\') || value.includes(':')) return false
  if (value.split('/').includes('..')) return false
  return true
}

// engine.json の配布物の一覧。assets(OS と CPU ごとの url / sha256 / entry と、
// 任意の windowEntry)を読み、darwin が採れなければ最上位の url / sha256 を
// darwin として補う(古い形との互換)。形が違えば null。条件を満たさない項目は捨てる。
export function parseEngineAssets(text) {
  const manifest = parseEngineManifest(text)
  if (!manifest) return null
  const assets = JSON.parse(text).assets
  const found = {}
  if (assets && typeof assets === 'object') {
    for (const platform of ['darwin', 'win32-x64', 'linux-x64']) {
      const item = assets[platform]
      if (!item || typeof item !== 'object') continue
      if (typeof item.url !== 'string' || !/^(https|file):\/\//.test(item.url)) continue
      if (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) continue
      // entry は配布物の中の、実行ファイルへの相対パス。外へ出る形は受け付けない
      const entry = item.entry
      if (!isEntryPath(entry)) continue
      const foundItem = { url: item.url, sha256: item.sha256, entry }
      // windowEntry は、ウィンドウ方式で起動する実行ファイル(任意)。形が違うときは
      // 無いものとして entry を使う(ウィンドウが開けなくてもペイン方式は動く)
      if (isEntryPath(item.windowEntry)) foundItem.windowEntry = item.windowEntry
      found[platform] = foundItem
    }
  }
  // 古い形(最上位だけ)でも、新しい形で darwin が抜けていても、Mac はこれで動く
  if (!found.darwin) {
    found.darwin = { url: manifest.url, sha256: manifest.sha256, entry: 'sukoshi-tako-engine/ChameleonPane' }
  }
  return found
}

// 出力のどこかにある、16 進 64 文字の語が、engine.json の値と同じか。行や位置を決め打ちしないので、
// shasum -a 256 / sha256sum / Windows の certutil -hashfile(1 行目が説明、2 行目がハッシュ、
// 3 行目が完了)のどれでも読める。
export function checksumMatches(output, expected) {
  const actual = String(output ?? '')
    .split(/\s+/)
    .find((word) => /^[0-9a-f]{64}$/i.test(word))
  return actual !== undefined && actual.toLowerCase() === expected.toLowerCase()
}

// OS ごとの「取得 → 照合 → 展開」の一連を argv で組み立てる。シェルは通さない。
// Windows も Windows 10 以降に入っている curl.exe / certutil / tar.exe だけで行う。
// 知らない OS は null(何も取りに行かない)。
export function fetchPlan({ platform, root, url }) {
  if (platform === 'darwin' || platform === 'linux-x64') {
    const archive = root + '/engine.tar.gz'
    const distDir = root + '/dist'
    const engineDir = distDir + '/sukoshi-tako-engine'
    return {
      archive,
      distDir,
      engineDir,
      marker: distDir + '/engine.sha256',
      download: ['curl', '-fsSL', '--retry', '2', '-o', archive, url],
      hash: platform === 'darwin' ? ['shasum', '-a', '256', archive] : ['sha256sum', archive],
      removeArchive: ['rm', '-f', archive],
      removeOld: ['rm', '-rf', engineDir],
      makeDist: ['mkdir', '-p', distDir],
      unpack: ['tar', '-xzf', archive, '-C', distDir],
    }
  }
  if (platform === 'win32-x64') {
    // del / rmdir / mkdir は cmd /c 経由(= シェル)。cmd が読み替える文字が場所にあるなら取りに行かない
    if (/[&|<>^%"!()]/.test(root)) return null
    const archive = root + '\\engine.tar.gz'
    const distDir = root + '\\dist'
    const engineDir = distDir + '\\sukoshi-tako-engine'
    return {
      archive,
      distDir,
      engineDir,
      marker: distDir + '\\engine.sha256',
      download: ['curl.exe', '-fsSL', '--retry', '2', '-o', archive, url],
      hash: ['certutil', '-hashfile', archive, 'SHA256'],
      removeArchive: ['cmd', '/c', 'del', '/f', '/q', archive],
      removeOld: ['cmd', '/c', 'rmdir', '/s', '/q', engineDir],
      makeDist: ['cmd', '/c', 'mkdir', distDir],
      unpack: ['tar.exe', '-xzf', archive, '-C', distDir],
    }
  }
  return null
}

// 入力ファイルの後始末。Windows に rm は無い
export function removeFileArgv(path, platform) {
  return platform === 'win32-x64' ? ['cmd', '/c', 'del', '/f', '/q', path] : ['rm', '-f', path]
}

// 取得や起動の準備を始めたときの番号と、今の番号。オフにしたりペインを閉じたりすると番号が進む。
// 進んでいたら、準備が終わっても本体は起動しない
export function isStartStillWanted(tokenAtStart, tokenNow) {
  return tokenAtStart === tokenNow
}

// 配布物の中の実行ファイルの場所
export function enginePathFor(root, platform, entry) {
  if (platform === 'darwin' || platform === 'linux-x64') return root + '/dist/' + entry
  if (platform === 'win32-x64') return root + '\\dist\\' + entry.replace(/\//g, '\\')
  return null
}

// ウィンドウ方式で起動する実行ファイル。windowEntry があればそれを、無ければ entry を使う
export function engineEntryFor(asset, mode) {
  if (!asset) return null
  if (mode === 'window' && typeof asset.windowEntry === 'string' && asset.windowEntry !== '') return asset.windowEntry
  return asset.entry
}

// 素材のパックの場所。本体は起動時にこれを読む(SUKOSHI_TAKO_PACK)
export function packPathFor(engineDir, platform) {
  if (typeof engineDir !== 'string' || engineDir === '') return null
  const separator = platform === 'win32-x64' ? '\\' : '/'
  return engineDir.replace(/[\\/]+$/, '') + separator + 'assets.pack'
}

// ---- メニュー ----

// コース選択のボタンの中身(onPress は register.js が足す)。
// autoFocus は「true か、付けない」のどちらかでなければ描画が拒否される。
export function stageButtonProps(stages) {
  return stages.slice(0, 9).map((stage, index) => ({
    key: 'stage-' + stage.id,
    label: stage.name,
    hotkey: String(index + 1),
    ...(index === 0 ? { autoFocus: true } : {}),
  }))
}

// ---- ターミナルの見分け ----

// 絵が出るのは kitty の画像の仕組みを持つ Ghostty と kitty だけ
// コマンドは commands/play.md と commands/off.md で宣言する。デスクトップアプリは実行時に登録した
// コマンドを一覧に載せないので、ターミナルでも同じ <プラグイン名>:<コマンド名> だけを使う。
export function commandNames(pluginName) {
  return [pluginName + ':play', pluginName + ':off']
}

export function commandAction(name, args) {
  if (String(name ?? '').endsWith(':off')) return 'off'
  return String(args ?? '').trim().toLowerCase() === 'off' ? 'off' : 'on'
}

export function canShowPixels({ termProgram, term, kittyWindowId }) {
  if ((termProgram ?? '').toLowerCase() === 'ghostty') return true
  if ((term ?? '').includes('kitty') || (term ?? '').includes('ghostty')) return true
  return Boolean(kittyWindowId)
}

// ---- 遊べる環境の見分け ----

// OS と CPU から、使う配布物の名前を決める。判定できない環境は null(何も取りに行かない)。
// Windows は環境変数 OS を先に見る(uname が無い)。Darwin は配布物がユニバーサルなので CPU を問わない。
export function platformKey({ envOS, unameS, unameM, processorArchitecture }) {
  if (envOS === 'Windows_NT') {
    return typeof processorArchitecture === 'string' && processorArchitecture.toLowerCase() === 'amd64'
      ? 'win32-x64'
      : null
  }
  const system = typeof unameS === 'string' ? unameS.trim() : ''
  if (system === 'Darwin') return 'darwin'
  if (system === 'Linux' && (unameM === 'x86_64' || unameM === 'amd64')) return 'linux-x64'
  return null
}

// その表示先と OS で、どの遊び方ができるか。
//   pane    ターミナルのペインの中に絵を出す(今までの Mac)
//   window  ゲーム本体が別ウィンドウを出す
//   none    遊べない(案内だけ出す)
// いま遊べるのは Mac だけ。Windows / Linux は、その配布物と取得を足すときに
// 'window' へ広げる(それまでは none のまま、確かめていない場所を遊べると言わない)。
// どの表示先で描いているかがまだ分からないとき(起動直後、コマンドの時点)の読み。
// 絵が出せるターミナルなら、今までどおりターミナルとして扱う。それ以外は分からないまま返し、
// ペインを描くときに決める。
export function surfaceOrGuess(surface, hasPixels) {
  if (surface) return surface
  return hasPixels === true ? 'terminal' : null
}

export function playMode({ surface, hasPixels, platform }) {
  if (platform !== 'darwin') return 'none'
  // ターミナル: 絵を出せる(Ghostty、kitty)ならペインの中、出せないなら別ウィンドウ
  if (surface === 'terminal') return hasPixels === true ? 'pane' : 'window'
  if (surface === 'desktop') return 'window'
  return 'none'
}

// ---- ペインに何を描くか ----
//
// paneView は「何を描くか」の平たい記述を返し、register.js はそれを要素に写すだけにする。
// 判定は全部ここに置いて、テストで固定できるようにする。

export const NEEDS_TERMINAL = 'すこしタコは、Mac のターミナルか Claude デスクトップアプリの Claude Code で遊べます。'
export const NEEDS_MAC = 'いまは macOS だけで遊べます。'
// ウィンドウ方式のペインに出す案内
export const WINDOW_NOTE = 'ゲームは別のウィンドウに出ています。'
export const WINDOW_HELP = 'キーとマウスは、ゲームのウィンドウで操作します。ウィンドウを閉じると終わります。'
// 本体が起動できなかった・@fatal を出したときの案内(Local 以外のセッションでは開けない)
export const WINDOW_UNAVAILABLE =
  'ゲームのウィンドウを開けませんでした。この Mac の上で動いている Claude Code から開いてください(Claude デスクトップアプリでは Local のセッション)。'

export function unavailableText(platform) {
  return platform === 'darwin' ? NEEDS_TERMINAL : NEEDS_MAC
}

// 絵のすぐ下に出す。1 行に詰めると狭いペインで折り返して絵から離れるので、短い行に分ける
const HELP = {
  seek: [
    '移動 十字キー/WASD · 狙う ドラッグ/IJKL · 上下 R/F',
    '撃つ クリック/Space(押し続けで連射)',
    '背後 C · 距離 V · さがし終わり Enter',
  ],
  hide: [
    '移動 十字キー/WASD · 視点 右ドラッグ/IJKL · 上下 R/F',
    '塗る 左ドラッグ · 体の向き Q/E',
    '1 色を拾う · 2 ブラシ · 3 ポーズ · 4 うつす · 5 全身にうつす',
    'ここに隠れる Enter',
  ],
}

// 本体のポーズ名 → アプリの中での呼び名
const POSE_NAMES = {
  stand: '立ち',
  idle: '立ち',
  crouch: 'しゃがみ',
  sit: '座り',
  crossLegged: 'あぐら',
  allFours: '四つん這い',
  prone: '伏せる',
  lieDown: '横たわる',
  sideLie: '横向き寝',
  curled: '丸まる',
  bridge: 'ブリッジ',
  wallFlat: '壁ぴた',
}

// 本体が送る状態の行(key=value; key=value)を、人が読める形にする。色のコードとボタンの
// 名前は出さない(見ても何もできない)。知らない形の行はそのまま出す。
export function readableHud(text) {
  const line = String(text ?? '')
  if (!line.includes('=')) return line
  const shown = []
  for (const field of line.split('; ')) {
    const at = field.indexOf('=')
    if (at < 0) continue
    const key = field.slice(0, at)
    const value = field.slice(at + 1)
    if (key === '色' || key === '確定') continue
    if (key === 'ポーズ') shown.push('ポーズ: ' + (POSE_NAMES[value] ?? value))
    else if (key === '探す') shown.push(...value.split(' / ').filter((part) => /^(みつけた|のこり)/.test(part)))
    else shown.push(key + ': ' + value)
  }
  return shown.join(' · ')
}

// state は、出し入れの状態(reduce)に、今の場面や表示用の値を重ねたもの。
// mode は playMode の戻り値。'none' は遊べないので案内だけを返す。
export function paneView(state, mode) {
  if (mode !== 'pane' && mode !== 'window') {
    return { kind: 'unavailable', text: unavailableText(state.platform) }
  }
  switch (state.scene) {
    case 'starting':
    case 'loading':
      return { kind: 'message', text: state.downloadStatus ?? '読み込んでいます…' }
    case 'menu':
      return menuView(state)
    case 'hide':
    case 'seek':
      return gameView(state, mode)
    case 'published':
    case 'result':
      return {
        kind: 'outcome',
        title: state.scene === 'published' ? '世界に隠れました' : '結果',
        detail: state.sceneDetail ?? '',
        button: { key: 'hub', label: 'ハブへ戻る', hotkey: '1', autoFocus: true },
      }
    default:
      return {
        kind: 'error',
        text: state.failure ?? 'うまく動いていません。',
        // ウィンドウ方式で開けなかったときは、Local のセッションで開くよう案内する
        guidance: mode === 'window' ? WINDOW_UNAVAILABLE : null,
        button: { key: 'retry', label: 'もう一度', hotkey: '1', autoFocus: true },
      }
  }
}

function menuView(state) {
  if (state.menuMode === null || state.menuMode === undefined) {
    return {
      kind: 'menu',
      title: '全世界モード',
      options: [
        { key: 'seek', label: '誰かを探しに行く', hotkey: '1', autoFocus: true, action: 'mode', mode: 'world_seek' },
        { key: 'hide', label: '世界に隠れる', hotkey: '2', action: 'mode', mode: 'world_hide' },
      ],
    }
  }
  const stages = Array.isArray(state.stages) ? state.stages : []
  return {
    kind: 'menu',
    title: state.menuMode === 'world_seek' ? 'どのコースを探しますか' : 'どのコースで隠れますか',
    options: [
      ...stageButtonProps(stages).map((props, index) => ({ ...props, action: 'stage', stageId: stages[index].id })),
      { key: 'back', label: '戻る', hotkey: '0', action: 'mode', mode: null },
    ],
  }
}

function gameView(state, mode) {
  if (mode === 'window') {
    // ウィンドウ方式: 絵は本体のウィンドウ。ペインには文字とボタンだけを出す
    return {
      kind: 'windowGame',
      note: WINDOW_NOTE,
      hud: readableHud(state.hud),
      help: WINDOW_HELP,
      keys: HELP[state.scene] ?? [],
      buttons: [
        { key: 'menu', label: 'メニューへ', hotkey: '1', autoFocus: true, action: 'event', event: 'back_to_hub' },
        { key: 'quit', label: 'やめる', hotkey: '2', action: 'close' },
      ],
    }
  }
  if (!state.hasFrame) return { kind: 'message', text: '読み込んでいます…' }
  const help = HELP[state.scene] ?? []
  return {
    kind: 'game',
    image: imageCells(state.columns, state.rows, help.length + 1 + (state.isDebug ? 1 : 0)),
    help,
    hud: readableHud(state.hud),
    debug: state.isDebug
      ? '届いたキー: ' + JSON.stringify(state.lastKey ?? '') + ' · 押下中: ' + (state.keys ?? []).join(' ')
      : null,
    status: state.phase === 'countdown'
      ? { text: 'Claude の作業が終わりました · あと ' + state.countdown, style: 'bold' }
      : null,
  }
}
