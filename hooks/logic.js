// sukoshi-tako の、$ に触らない部分。register.js が使い、テストが直接呼ぶ。

export const DROP_IN_DELAY_MS = 2000
export const COUNTDOWN_SECONDS = 3
// 入力ファイルの 3 行目に残す単発操作の数。エンジンは番号で処理済みを見分ける
export const EVENTS_KEPT = 8

// ---- 出し入れの状態機械 ----
//
//   idle       遊んでいない(Claude が作業中かどうかは問わない)
//   waiting    Claude が作業中。待ち時間が過ぎたら入る
//   offered    ターミナルが狭くて自動では開けなかった。帯のボタンで開ける
//   playing    ペインが開いていて遊んでいる
//   countdown  Claude の作業が終わった。数え終わったら閉じる

export function initialState() {
  return { phase: 'idle', isOn: false, isTurnRunning: false, isDismissed: false, countdown: 0 }
}

// 返すのは次の状態と、register.js が実行する副作用の名前の並び。
//   armDropIn / cancelTimer / open / close / startCountdown / redraw
export function reduce(state, action) {
  const next = { ...state }
  const effects = []
  const canArm = () => next.isOn && next.isTurnRunning && !next.isDismissed && next.phase === 'idle'
  const arm = () => {
    if (!canArm()) return
    next.phase = 'waiting'
    effects.push('armDropIn')
  }
  const pullOut = () => {
    effects.push('cancelTimer')
    if (next.phase === 'playing' || next.phase === 'countdown') effects.push('close')
    else effects.push('redraw')
    next.phase = 'idle'
  }

  switch (action.type) {
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
      if (next.phase === 'waiting' || next.phase === 'offered') {
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
      // Claude が確認を出す。プロンプトを見せるために即座に引く
      if (next.phase !== 'idle') pullOut()
      break
    case 'toolRan':
      // 確認に答えて Claude が続きを始めたら、また入る
      arm()
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

// ---- 入力ファイル ----

export function idlePointer() {
  return { isLeftDown: false, isRightDown: false, x: 0, y: 0, leftDowns: 0, leftUps: 0, rightDowns: 0, rightUps: 0 }
}

// エンジンと共有する約束。3 行で、必ず改行で終わる。
export function inputFileText({ isPlaying, keys, pointer, events }) {
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

// 入力ファイルの置き場所。ほかのユーザーも書ける /tmp ではなく、ユーザーごとの一時フォルダ
// (macOS の TMPDIR、自分だけが読み書きできる)に置く。絶対パスでなければ /tmp に戻す。
export function inputPathFor(tmpdir, id) {
  const base = typeof tmpdir === 'string' && tmpdir.startsWith('/') ? tmpdir.replace(/\/+$/, '') : '/tmp'
  return base + '/sukoshi-tako-' + id + '.input'
}

// 開発用の SUKOSHI_TAKO_ENGINE。SHA-256 の照合を通らずに任意の実行ファイルを起動できてしまうので、
// SUKOSHI_TAKO_DEV=1 の明示的な許可があり、かつ絶対パス(または fake)のときだけ受け付ける。
export function resolveEngineOverride(override, devFlag) {
  if (devFlag !== '1' || typeof override !== 'string') return null
  if (override === 'fake') return 'fake'
  return override.startsWith('/') ? override : null
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

// `shasum -a 256 <file>` の出力の先頭が、engine.json の値と同じか
export function checksumMatches(shasumOutput, expected) {
  const actual = shasumOutput.trim().split(/\s+/)[0] ?? ''
  return /^[0-9a-f]{64}$/i.test(actual) && actual.toLowerCase() === expected.toLowerCase()
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
export function canShowPixels({ termProgram, term, kittyWindowId }) {
  if ((termProgram ?? '').toLowerCase() === 'ghostty') return true
  if ((term ?? '').includes('kitty') || (term ?? '').includes('ghostty')) return true
  return Boolean(kittyWindowId)
}
