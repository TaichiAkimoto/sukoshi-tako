import { describe, expect, test } from 'claude-code/testing'

import { fraction, heldKeys, keyName, notePointer, notePress } from '../hooks/input.js'

function freshPointer() {
  return { isLeftDown: false, isRightDown: false, x: 0, y: 0, leftDowns: 0, leftUps: 0, rightDowns: 0, rightUps: 0 }
}

describe('キーの名前', () => {
  test('文字は小文字に、空白は space に、特殊キーはそのまま', () => {
    expect(keyName('W')).toBe('w')
    expect(keyName(' ')).toBe('space')
    expect(keyName('up')).toBe('up')
    expect(keyName('return')).toBe('return')
  })

  test('スペースは、文字で届いても名前で届いても space にする', () => {
    expect(keyName(' ')).toBe('space')
    expect(keyName('space')).toBe('space')
    expect(keyName('Space')).toBe('space')
  })

  test('Enter は return でも enter でも return にする', () => {
    expect(keyName('return')).toBe('return')
    expect(keyName('enter')).toBe('return')
    expect(keyName('\r')).toBe('return')
  })

  test('扱わない特殊キーは null', () => {
    expect(keyName('pageup')).toBe(null)
    expect(keyName('backspace')).toBe(null)
  })
})

describe('押しっぱなしの推定', () => {
  test('1 回押しただけなら 550ms の間は押されている扱い', () => {
    const presses = new Map()
    notePress(presses, 'w', 1000)
    expect(heldKeys(presses, 1549)).toEqual(['w'])
    expect(heldKeys(presses, 1550)).toEqual([])
    expect(presses.size).toBe(0)
  })

  test('リピートが流れている間は、最後の通知から 120ms で離した扱い', () => {
    const presses = new Map()
    notePress(presses, 'w', 1000)
    notePress(presses, 'w', 1500)
    notePress(presses, 'w', 1533)
    expect(heldKeys(presses, 1652)).toEqual(['w'])
    expect(heldKeys(presses, 1653)).toEqual([])
  })

  test('間が空いてから押し直したら、また長めに待つ', () => {
    const presses = new Map()
    notePress(presses, 'w', 1000)
    expect(heldKeys(presses, 2000)).toEqual([])
    notePress(presses, 'w', 2000)
    expect(heldKeys(presses, 2400)).toEqual(['w'])
  })

  test('複数のキーは名前順に返す', () => {
    const presses = new Map()
    notePress(presses, 'w', 1000)
    notePress(presses, 'a', 1000)
    expect(heldKeys(presses, 1100)).toEqual(['a', 'w'])
  })
})

describe('マウス', () => {
  test('セルの位置を割合に直す。細かい位置があればそれを使う', () => {
    expect(fraction({ type: 'move', x: 40, y: 10 }, 80, 20)).toEqual({ x: 40.5 / 80, y: 10.5 / 20 })
    expect(fraction({ type: 'move', x: 40, y: 10, fine: { x: 40.25, y: 10.75 } }, 80, 20)).toEqual({
      x: 40.25 / 80,
      y: 10.75 / 20,
    })
  })

  test('領域の外に出ても 0〜1 に収める', () => {
    expect(fraction({ type: 'move', x: -5, y: 30 }, 80, 20)).toEqual({ x: 0, y: 1 })
  })

  test('押した回数と離した回数を数える(短いクリックを取り落とさないため)', () => {
    const pointer = freshPointer()
    notePointer(pointer, { type: 'down', x: 10, y: 5, button: 'left' }, 80, 20)
    notePointer(pointer, { type: 'up', x: 10, y: 5, button: 'left' }, 80, 20)
    notePointer(pointer, { type: 'down', x: 10, y: 5, button: 'left' }, 80, 20)
    expect(pointer.leftDowns).toBe(2)
    expect(pointer.leftUps).toBe(1)
    expect(pointer.isLeftDown).toBe(true)
    expect(pointer.rightDowns).toBe(0)
  })

  test('右ボタンは左と別に数える', () => {
    const pointer = freshPointer()
    notePointer(pointer, { type: 'down', x: 10, y: 5, button: 'right' }, 80, 20)
    expect(pointer.isRightDown).toBe(true)
    expect(pointer.isLeftDown).toBe(false)
  })

  test('enter と leave では位置を変えない', () => {
    const pointer = freshPointer()
    notePointer(pointer, { type: 'move', x: 40, y: 10 }, 80, 20)
    const before = { ...pointer }
    notePointer(pointer, { type: 'leave', x: 0, y: 0 }, 80, 20)
    expect(pointer).toEqual(before)
  })
})
