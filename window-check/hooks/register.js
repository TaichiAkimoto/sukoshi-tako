// すこしタコを Windows / Linux に対応させるための確認(その 2)。
// /tako-window-check と打つと、箱を 1 つ描くだけの小さなプログラムを、ゲーム本体と同じ手順
// (取得 → SHA-256 の照合 → 展開 → 起動)で動かし、ウィンドウが出たか、キーの押下と解放が
// 届いたか、別のウィンドウに切り替えたことが分かったかを調べる。結果は画面と、ホームフォルダの
// tako-window-check-report.txt に書く。ゲームは入っていない。
import { checksumMatches, enginePathFor, fetchPlan, parseEngineAssets, platformKey, splitLines } from './logic.js'

const PANE = 'tako-window-check'
const TITLE = 'すこしタコ ウィンドウの確認'
const PROBE_SECONDS = 40

let report = []
let surface = '(まだ描いていない)'
let reportPath = null
let home = null
let isRunning = false

// 結果にユーザー名入りのパスを残さない
function tidy(text) {
  return home ? String(text).split(home).join('~') : String(text)
}

function add(line) {
  report.push(tidy(line))
}

function reportText() {
  return ['表示先: ' + surface, ...report].join('\n')
}

async function save($) {
  if (!reportPath) return
  try {
    await $.fs.write(reportPath, reportText() + '\n')
  } catch (error) {
    add('結果の保存: 失敗 ' + String(error).slice(0, 120))
  }
}

async function step($, label, argv, timeoutMs = 15000) {
  try {
    const result = await $.process.run(argv, { timeoutMs })
    add(label + ': exit ' + result.exitCode)
    return result
  } catch (error) {
    add(label + ': 失敗 ' + String(error).slice(0, 120))
    return null
  }
}

async function runChecks($) {
  report = []
  const os = await $.env.get('OS')
  const isWindows = os === 'Windows_NT'
  home = (isWindows ? await $.env.get('USERPROFILE') : await $.env.get('HOME')) ?? null
  const sep = isWindows ? '\\' : '/'
  reportPath = home ? home + sep + 'tako-window-check-report.txt' : null
  const root = $.plugin.root

  let unameS = null
  let unameM = null
  if (!isWindows) {
    unameS = (await $.process.run(['uname', '-s'])).stdout
    unameM = (await $.process.run(['uname', '-m'])).stdout.trim()
  }
  const platform = platformKey({
    envOS: os,
    unameS,
    unameM,
    processorArchitecture: await $.env.get('PROCESSOR_ARCHITECTURE'),
  })
  add('OS の種類: ' + platform)
  add('プラグインのフォルダに ASCII 以外の文字: ' + (/[^\x20-\x7e]/.test(root) ? 'あり' : 'なし'))
  add('プラグインのフォルダに空白: ' + (root.includes(' ') ? 'あり' : 'なし'))
  try {
    add('Claude Code: ' + JSON.stringify(await $.session.version()))
  } catch (error) {
    add('Claude Code: 取得できず ' + String(error).slice(0, 80))
  }
  if (!platform) {
    add('この OS と CPU の組み合わせには、確認用のプログラムがありません。')
    return save($)
  }

  let assets = null
  try {
    assets = parseEngineAssets(await $.fs.read(root + sep + 'engine.json'))
  } catch (error) {
    add('engine.json を読む: 失敗 ' + String(error).slice(0, 120))
  }
  const asset = assets ? assets[platform] : null
  if (!asset) {
    add('engine.json: この OS の行がありません。')
    return save($)
  }
  const plan = fetchPlan({ platform, root, url: asset.url })

  // 取得 → 照合 → 展開(ゲーム本体と同じ並び)
  if (!(await $.fs.exists(plan.distDir).catch(() => false))) await step($, 'フォルダを作る', plan.makeDist)
  if (await $.fs.exists(plan.engineDir).catch(() => false)) await step($, '前の分を消す', plan.removeOld)
  const fetched = await step($, '取得', plan.download, 5 * 60 * 1000)
  if (!fetched || fetched.exitCode !== 0) return save($)
  const sum = await step($, 'ハッシュを計算', plan.hash)
  const isMatch = !!sum && sum.exitCode === 0 && checksumMatches(sum.stdout, asset.sha256)
  add('ハッシュの照合: ' + (isMatch ? '一致' : '不一致'))
  if (!isMatch) {
    await step($, '取得したファイルを消す', plan.removeArchive)
    return save($)
  }
  const unpacked = await step($, '展開', plan.unpack, 60000)
  await step($, '取得したファイルを消す', plan.removeArchive)
  if (!unpacked || unpacked.exitCode !== 0) return save($)
  const enginePath = enginePathFor(root, platform, asset.entry)
  add('実行ファイルがある: ' + (await $.fs.exists(enginePath).catch(() => 'error')))
  await save($)

  // 起動して、標準出力を流し読みする
  add('ウィンドウ: 起動します(' + PROBE_SECONDS + ' 秒で自動的に閉じます)')
  $.ui.invalidate('ui.render')
  let pending = ''
  let lineCount = 0
  try {
    for await (const chunk of $.process.spawn({ argv: [enginePath, 'probe', '--seconds', String(PROBE_SECONDS)] })) {
      if (chunk.stream !== 'stdout') continue
      const split = splitLines(pending, chunk.text)
      pending = split.pending
      for (const line of split.lines) {
        const text = line.trim()
        if (!text.startsWith('@probe') && !text.startsWith('@fatal')) continue
        lineCount += 1
        add('本体: ' + text.slice(0, 120))
        $.ui.invalidate('ui.render')
        await save($)
      }
    }
  } catch (error) {
    add('起動: 失敗 ' + String(error).slice(0, 160))
  }
  add('本体から届いた行: ' + lineCount)
  await save($)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tako-window-check',
      description: 'すこしタコのウィンドウの確認(小さなプログラムを取得して起動する)',
    })
    return next(e)
  })

  // 短い名前は実行時に登録したもの(ターミナル)。デスクトップアプリはファイルで宣言したコマンド
  // だけを一覧に出すので、commands/tako-window-check.md でも宣言している。
  for (const name of ['tako-window-check', 'tako-window-check:tako-window-check']) {
    on('command.run', { command: name }, async ($) => {
      if (isRunning) return { text: 'いま確認中です。ウィンドウが閉じるまでお待ちください。' }
      isRunning = true
      try {
        await $.ui.open({ id: PANE, title: TITLE, focus: false })
      } catch (error) {
        // ペインが開けなくても、確認そのものは続ける
      }
      try {
        await runChecks($)
      } finally {
        isRunning = false
      }
      $.ui.invalidate('ui.render')
      return {
        text: [
          'すこしタコ ウィンドウの確認の結果',
          ...report,
          reportPath ? '保存先: ' + tidy(reportPath) : '保存先: なし',
        ].join('\n'),
      }
    })
  }

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    surface = e.surface
    const { Box, Text } = $.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      gap: 1,
      children: [
        Text({ bold: true, children: ['表示先: ' + e.surface] }),
        Text({
          children: [
            'ウィンドウが出たら: (1) ウィンドウをクリック (2) 何かキーを押して離す (3) 別のウィンドウをクリック',
          ],
        }),
        Text({ children: [report.join('\n')] }),
      ],
    })
  })
}
