// すこしタコを Windows / Linux に対応させるための動作確認。
// /tako-check と打つと、この環境でプラグインにできること(コマンドの実行、フォルダの作成と削除、
// 子プロセスの起動、ペインとボタン)を調べて、結果を画面に出し、ホームフォルダの
// tako-check-report.txt にも書く。ゲームは起動しない。ネットワークには接続しない。
const PANE = 'tako-check'
const TITLE = 'すこしタコ 動作確認'

let report = []
let surface = '(まだ描いていない)'
let presses = 0
let reportPath = null
let home = null

// 結果にユーザー名入りのパスを残さない
function tidy(text) {
  return home ? String(text).split(home).join('~') : String(text)
}

function add(line) {
  report.push(tidy(line))
}

// isHash のときは、出力そのもの(ファイルの場所が入る)ではなく、64 桁のハッシュが読めたかだけを残す
async function tryRun($, label, argv, isHash = false) {
  try {
    const result = await $.process.run(argv, { timeoutMs: 15000 })
    const output = result.stdout || result.stderr || ''
    const shown = isHash
      ? '64 桁のハッシュ: ' + (output.split(/\s+/).some((word) => /^[0-9a-f]{64}$/i.test(word)) ? 'あり' : 'なし')
      : output.split('\n')[0].trim().slice(0, 80)
    add(label + ': exit ' + result.exitCode + ' / ' + shown)
  } catch (error) {
    add(label + ': 失敗 ' + String(error).slice(0, 120))
  }
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

async function runChecks($) {
  report = []
  const os = await $.env.get('OS')
  const isWindows = os === 'Windows_NT'
  home = (isWindows ? await $.env.get('USERPROFILE') : await $.env.get('HOME')) ?? null
  const sep = isWindows ? '\\' : '/'
  reportPath = home ? home + sep + 'tako-check-report.txt' : null
  const manifest = $.plugin.root + sep + '.claude-plugin' + sep + 'plugin.json'

  add('OS(環境変数): ' + os)
  add('CPU(環境変数): ' + (await $.env.get('PROCESSOR_ARCHITECTURE')))
  add('ホームフォルダ: ' + (home ? 'あり' : 'なし'))
  try {
    add('Claude Code: ' + JSON.stringify(await $.session.version()))
  } catch (error) {
    add('Claude Code: 取得できず ' + String(error).slice(0, 80))
  }

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

  try {
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    add('ペインを開く: ' + JSON.stringify(opened))
  } catch (error) {
    add('ペインを開く: 失敗 ' + String(error).slice(0, 120))
  }
  await save($)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tako-check', description: 'すこしタコの動作確認(この環境で何ができるかを調べる)' })
    return next(e)
  })

  // The short name is registered at run time (terminal). The desktop app lists only commands a
  // plugin declares as files, so commands/tako-check.md declares it too; that one is named
  // <plugin>:<command>, and this hook answers it before it reaches the model.
  for (const name of ['tako-check', 'tako-check:tako-check']) {
    on('command.run', { command: name }, async ($) => {
      await runChecks($)
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
        Text({ bold: true, children: ['表示先: ' + e.surface + ' / ボタンを押した回数: ' + presses] }),
        Button({
          key: 'press',
          label: 'このボタンを押してください',
          hotkey: '1',
          autoFocus: true,
          onPress: async () => {
            presses += 1
            $.ui.invalidate('ui.render')
            await save($)
          },
        }),
        Text({ children: [report.join('\n')] }),
        Text({ children: [reportPath ? '結果は ' + tidy(reportPath) + ' に保存しました。このファイルを送ってください。' : ''] }),
      ],
    })
  })
}
