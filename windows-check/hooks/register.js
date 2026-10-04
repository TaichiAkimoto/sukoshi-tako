// すこしタコを Windows / Linux に対応させるための動作確認。
// /tako-check と打つと、次の 2 つを続けて調べ、結果を画面と、ホームフォルダの
// tako-check-report.txt に書く。
//   1. この環境でプラグインにできること(コマンドの実行、フォルダの作成と削除、子プロセスの起動、
//      ペインとボタン)
//   2. 箱を 1 つ描くだけの小さなプログラムを、ゲーム本体と同じ手順(取得 → SHA-256 の照合 →
//      展開 → 起動)で動かし、ウィンドウが出たか、キーの押下と解放が届いたか
// ゲームは入っていない。ネットワークに出るのは、2 の小さなプログラムの取得だけ。
import { checksumMatches, enginePathFor, fetchPlan, parseEngineAssets, platformKey, splitLines } from './logic.js'

const PANE = 'tako-check'
const TITLE = 'すこしタコ 動作確認'
const PROBE_SECONDS = 40

let report = []
let surface = '(まだ描いていない)'
let presses = 0
let reportPath = null
let home = null
let isRunning = false
let stage = '準備中'

// 結果にユーザー名入りのパスを残さない
function tidy(text) {
  return home ? String(text).split(home).join('~') : String(text)
}

function add(line) {
  report.push(tidy(line))
}

function reportText() {
  return ['表示先: ' + surface, 'ボタンを押した回数: ' + presses, ...report].join('\n')
}

async function save($) {
  if (!reportPath) return
  try {
    await $.fs.write(reportPath, reportText() + '\n')
  } catch (error) {
    add('結果の保存: 失敗 ' + String(error).slice(0, 120))
  }
}

// isHash のときは、出力そのもの(ファイルの場所が入る)ではなく、64 桁のハッシュが読めたかだけを残す
async function tryRun($, label, argv, isHash = false, timeoutMs = 15000) {
  try {
    const result = await $.process.run(argv, { timeoutMs })
    const output = result.stdout || result.stderr || ''
    const shown = isHash
      ? '64 桁のハッシュ: ' + (output.split(/\s+/).some((word) => /^[0-9a-f]{64}$/i.test(word)) ? 'あり' : 'なし')
      : output.split('\n')[0].trim().slice(0, 80)
    add(label + ': exit ' + result.exitCode + ' / ' + shown)
    return result
  } catch (error) {
    add(label + ': 失敗 ' + String(error).slice(0, 120))
    return null
  }
}

// 1. この環境でプラグインにできること
async function checkBasics($, isWindows, sep) {
  const manifest = $.plugin.root + sep + '.claude-plugin' + sep + 'plugin.json'
  if (isWindows) {
    await tryRun($, 'curl.exe', ['curl.exe', '--version'])
    await tryRun($, 'certutil', ['certutil', '-hashfile', manifest, 'SHA256'], true)
    await tryRun($, 'tar.exe', ['tar.exe', '--version'])
    await tryRun($, 'ver', ['cmd', '/c', 'ver'])
  } else {
    await tryRun($, 'uname', ['uname', '-sm'])
    await tryRun($, 'curl', ['curl', '--version'])
    await tryRun($, 'shasum', ['shasum', '-a', '256', manifest], true)
    await tryRun($, 'sha256sum', ['sha256sum', manifest], true)
    await tryRun($, 'tar', ['tar', '--version'])
  }

  // フォルダを作る・ファイルを消す・フォルダを消す(空白入りのパスで)
  const tmp = isWindows ? await $.env.get('TEMP') : ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
  if (tmp) {
    const dir = tmp + sep + 'tako check test'
    const file = dir + sep + 'a.txt'
    const exists = (path) => $.fs.exists(path).catch(() => 'error')
    await tryRun($, 'フォルダを作る', isWindows ? ['cmd', '/c', 'mkdir', dir] : ['mkdir', '-p', dir])
    add('  作った後にある: ' + (await exists(dir)))
    await $.fs.write(file, 'x\n').then(
      () => add('ファイルを書く: ok'),
      (error) => add('ファイルを書く: 失敗 ' + String(error).slice(0, 80)),
    )
    await tryRun($, 'ファイルを消す', isWindows ? ['cmd', '/c', 'del', '/f', '/q', file] : ['rm', '-f', file])
    add('  消した後にある: ' + (await exists(file)))
    await tryRun($, 'フォルダを消す', isWindows ? ['cmd', '/c', 'rmdir', '/s', '/q', dir] : ['rm', '-rf', dir])
    add('  消した後にある: ' + (await exists(dir)))
  } else {
    add('一時フォルダ: 見つからない')
  }

  // 子プロセスを起動して、出力を流し読みする(ゲーム本体の起動と同じ仕組み)
  try {
    const argv = isWindows
      ? ['cmd', '/c', 'echo first& ping -n 2 127.0.0.1 >nul & echo second']
      : ['sh', '-c', 'echo first; sleep 1; echo second']
    let seen = ''
    for await (const chunk of $.process.spawn({ argv })) {
      if (chunk.stream === 'stdout') seen += chunk.text
    }
    add('子プロセス: ' + seen.trim().replace(/\s+/g, ' '))
  } catch (error) {
    add('子プロセス: 失敗 ' + String(error).slice(0, 120))
  }
}

// 2. 小さなプログラムを取得して起動し、ウィンドウとキー入力を確かめる
async function checkWindow($, platform, sep) {
  const root = $.plugin.root
  add('プラグインのフォルダに ASCII 以外の文字: ' + (/[^\x20-\x7e]/.test(root) ? 'あり' : 'なし'))
  add('プラグインのフォルダに空白: ' + (root.includes(' ') ? 'あり' : 'なし'))
  if (!platform) {
    add('ウィンドウの確認: この OS と CPU の組み合わせには、確認用のプログラムがありません。')
    return
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
    return
  }
  const plan = fetchPlan({ platform, root, url: asset.url })

  // 取得 → 照合 → 展開(ゲーム本体と同じ並び)
  if (!(await $.fs.exists(plan.distDir).catch(() => false))) await tryRun($, '展開先を作る', plan.makeDist)
  if (await $.fs.exists(plan.engineDir).catch(() => false)) await tryRun($, '前の分を消す', plan.removeOld)
  const fetched = await tryRun($, '取得', plan.download, false, 5 * 60 * 1000)
  if (!fetched || fetched.exitCode !== 0) return
  const sum = await tryRun($, 'ハッシュを計算', plan.hash, true)
  const isMatch = !!sum && sum.exitCode === 0 && checksumMatches(sum.stdout, asset.sha256)
  add('ハッシュの照合: ' + (isMatch ? '一致' : '不一致'))
  if (!isMatch) {
    await tryRun($, '取得したファイルを消す', plan.removeArchive)
    return
  }
  const unpacked = await tryRun($, '展開', plan.unpack, false, 60000)
  await tryRun($, '取得したファイルを消す', plan.removeArchive)
  if (!unpacked || unpacked.exitCode !== 0) return
  const enginePath = enginePathFor(root, platform, asset.entry)
  add('実行ファイルがある: ' + (await $.fs.exists(enginePath).catch(() => 'error')))
  await save($)

  // 起動して、標準出力を流し読みする
  stage = '箱のウィンドウが出ます。クリックして、何かキーを押して離し、別のウィンドウをクリックしてください'
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
}

async function runChecks($) {
  report = []
  const os = await $.env.get('OS')
  const isWindows = os === 'Windows_NT'
  home = (isWindows ? await $.env.get('USERPROFILE') : await $.env.get('HOME')) ?? null
  const sep = isWindows ? '\\' : '/'
  reportPath = home ? home + sep + 'tako-check-report.txt' : null

  add('OS(環境変数): ' + os)
  const arch = await $.env.get('PROCESSOR_ARCHITECTURE')
  add('CPU(環境変数): ' + arch)
  add('ホームフォルダ: ' + (home ? 'あり' : 'なし'))
  try {
    add('Claude Code: ' + JSON.stringify(await $.session.version()))
  } catch (error) {
    add('Claude Code: 取得できず ' + String(error).slice(0, 80))
  }

  stage = '調べています(1/2: プラグインにできること)'
  $.ui.invalidate('ui.render')
  await checkBasics($, isWindows, sep)
  await save($)

  let unameS = null
  let unameM = null
  if (!isWindows) {
    try {
      unameS = (await $.process.run(['uname', '-s'])).stdout
      unameM = (await $.process.run(['uname', '-m'])).stdout.trim()
    } catch (error) {
      add('uname: 失敗 ' + String(error).slice(0, 80))
    }
  }
  const platform = platformKey({ envOS: os, unameS, unameM, processorArchitecture: arch })
  add('OS の種類: ' + platform)
  stage = '調べています(2/2: 小さなプログラムを取得しています)'
  $.ui.invalidate('ui.render')
  await checkWindow($, platform, sep)
  stage = '終わりました。下のボタンを 1 回押してから、結果のファイルを送ってください'
  await save($)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tako-check', description: 'すこしタコの動作確認(この環境で何ができるかを調べる)' })
    return next(e)
  })

  // 短い名前は実行時に登録したもの(ターミナル)。デスクトップアプリはファイルで宣言したコマンド
  // だけを一覧に出すので、commands/tako-check.md でも宣言している(<プラグイン名>:<コマンド名>)。
  for (const name of ['tako-check', 'tako-check:tako-check']) {
    on('command.run', { command: name }, async ($) => {
      if (isRunning) return { text: 'いま確認中です。箱のウィンドウが閉じるまでお待ちください。' }
      isRunning = true
      try {
        const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true }).then(
          (result) => JSON.stringify(result),
          (error) => '失敗 ' + String(error).slice(0, 120),
        )
        await runChecks($)
        add('ペインを開く: ' + opened)
        await save($)
      } finally {
        isRunning = false
      }
      $.ui.invalidate('ui.render')
      return {
        text: [
          'すこしタコ 動作確認の結果',
          ...report,
          reportPath ? '保存先: ' + tidy(reportPath) : '保存先: なし',
          'ペインが出ていたら、ボタンを押してください。',
        ].join('\n'),
      }
    })
  }

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    if (surface !== e.surface) {
      surface = e.surface
      void save($)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      gap: 1,
      children: [
        Text({ bold: true, children: [stage] }),
        Button({
          key: 'press',
          label: 'このボタンを押してください(' + presses + ' 回)',
          hotkey: '1',
          autoFocus: true,
          onPress: async () => {
            presses += 1
            $.ui.invalidate('ui.render')
            await save($)
          },
        }),
        Text({ dimColor: true, children: ['表示先: ' + e.surface] }),
        Text({ children: [report.join('\n')] }),
        Text({ children: [reportPath ? '結果は ' + tidy(reportPath) + ' に保存しています。' : ''] }),
      ],
    })
  })
}
