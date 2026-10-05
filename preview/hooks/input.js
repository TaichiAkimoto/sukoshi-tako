// ゲームの絵の上でキーとマウスを受け、「いま押されているもの」を register.js へ送る。
//
// ターミナルはキーを押したことは知らせるが、離したことは知らせない。そこで
// 「自動リピートが止まったら離した」とみなす: 1 回押しただけなら最初のリピートが
// 来るまで長めに、リピートが流れている間は短く待つ。マウスのボタンは離したことも届く。

const HOLD_AFTER_PRESS_MS = 550
const HOLD_WHILE_REPEATING_MS = 120
const POST_EVERY_MS = 30

// ターミナルが返すキーを、エンジンと約束した名前に直す。扱わないキーは null
// スペースと Enter は、ターミナルによって文字で届くことも名前で届くこともある。
export function keyName(key) {
  const lower = key.toLowerCase()
  if (key === ' ' || lower === 'space') return 'space'
  if (key === '\r' || key === '\n' || lower === 'return' || lower === 'enter') return 'return'
  if (lower === 'up' || lower === 'down' || lower === 'left' || lower === 'right') return lower
  return key.length === 1 ? lower : null
}

export function notePress(presses, name, now) {
  const last = presses.get(name)
  presses.set(name, { at: now, isRepeating: !!last && now - last.at < HOLD_AFTER_PRESS_MS })
}

// いま押されているとみなすキー。期限の切れたものは presses から消す
export function heldKeys(presses, now) {
  const held = []
  for (const [name, press] of presses) {
    const holdMs = press.isRepeating ? HOLD_WHILE_REPEATING_MS : HOLD_AFTER_PRESS_MS
    if (now - press.at < holdMs) held.push(name)
    else presses.delete(name)
  }
  return held.sort()
}

// セルの位置を、絵の左上を 0、右下を 1 とする割合に直す
export function fraction(event, columns, rows) {
  const x = (event.fine?.x ?? event.x + 0.5) / Math.max(1, columns)
  const y = (event.fine?.y ?? event.y + 0.5) / Math.max(1, rows)
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
}

export function notePointer(pointer, event, columns, rows) {
  if (event.type === 'enter' || event.type === 'leave') return
  const at = fraction(event, columns, rows)
  pointer.x = at.x
  pointer.y = at.y
  const isLeft = event.button === 'left'
  const isRight = event.button === 'right'
  if (event.type === 'down') {
    if (isLeft) { pointer.isLeftDown = true; pointer.leftDowns += 1 }
    if (isRight) { pointer.isRightDown = true; pointer.rightDowns += 1 }
  }
  if (event.type === 'up') {
    if (isLeft) { pointer.isLeftDown = false; pointer.leftUps += 1 }
    if (isRight) { pointer.isRightDown = false; pointer.rightUps += 1 }
  }
}

export default function GameInput(props, surface) {
  if (surface.state === undefined) {
    const input = {
      presses: new Map(), // キー名 -> { at, isRepeating }
      pointer: { isLeftDown: false, isRightDown: false, x: 0, y: 0, leftDowns: 0, leftUps: 0, rightDowns: 0, rightUps: 0 },
      lastKey: '',
      posted: '',
    }

    surface.onKey((e) => {
      // 届いたままのキー。SUKOSHI_TAKO_DEBUG のときに register.js が画面に出す
      input.lastKey = e.key
      const name = keyName(e.key)
      if (name !== null) notePress(input.presses, name, Date.now())
    })

    surface.onPointer((e) => {
      notePointer(input.pointer, e, surface.columns, surface.rows)
    })

    surface.every(POST_EVERY_MS, () => {
      const message = { keys: heldKeys(input.presses, Date.now()), pointer: { ...input.pointer }, lastKey: input.lastKey }
      const text = JSON.stringify(message)
      if (text === input.posted) return
      input.posted = text
      surface.post(message)
    })

    surface.setState(input)
  }

  const { Box } = surface.elements
  return Box({ width: '100%', height: '100%' })
}
