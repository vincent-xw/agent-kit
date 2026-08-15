import { describe, expect, it, vi } from 'vitest'
import { AdbClient } from './adb-client.js'

function clientWithSpy() {
  const client = new AdbClient()
  const shell = vi.spyOn(client, 'shell').mockResolvedValue('')
  return { client, shell }
}

describe('AdbClient.getDefaultIme', () => {
  it('读取 default_input_method 并 trim 换行', async () => {
    const { client, shell } = clientWithSpy()
    shell.mockResolvedValue('com.android.adbkeyboard/.AdbIME\n')

    const result = await client.getDefaultIme()

    expect(result).toBe('com.android.adbkeyboard/.AdbIME')
    expect(shell).toHaveBeenCalledWith('settings', ['get', 'secure', 'default_input_method'], undefined)
  })

  it('设备返回 null 时视为空', async () => {
    const { client, shell } = clientWithSpy()
    shell.mockResolvedValue('null\n')

    expect(await client.getDefaultIme()).toBe('')
  })

  it('设备返回空白时视为空', async () => {
    const { client, shell } = clientWithSpy()
    shell.mockResolvedValue('  \n')

    expect(await client.getDefaultIme()).toBe('')
  })

  it('透传设备序列号', async () => {
    const { client, shell } = clientWithSpy()
    shell.mockResolvedValue('x\n')

    await client.getDefaultIme('emulator-5554')

    expect(shell).toHaveBeenCalledWith('settings', ['get', 'secure', 'default_input_method'], 'emulator-5554')
  })
})

describe('AdbClient.clearTextViaIme', () => {
  it('发送 ADB_CLEAR_TEXT 广播', async () => {
    const { client, shell } = clientWithSpy()

    await client.clearTextViaIme()

    expect(shell).toHaveBeenCalledWith('am', ['broadcast', '-a', 'ADB_CLEAR_TEXT'], undefined)
  })
})

describe('AdbClient.inputTextViaIme', () => {
  it('中文文本按 UTF-8 base64 编码后广播', async () => {
    const { client, shell } = clientWithSpy()

    await client.inputTextViaIme('杭州')

    expect(shell).toHaveBeenCalledWith(
      'am',
      ['broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', '5p2t5bee'],
      undefined,
    )
  })

  it('ASCII 文本同样走 base64', async () => {
    const { client, shell } = clientWithSpy()

    await client.inputTextViaIme('hello')

    expect(shell).toHaveBeenCalledWith(
      'am',
      ['broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', 'aGVsbG8='],
      undefined,
    )
  })

  it('base64 结果不含 shell 元字符', async () => {
    const { client, shell } = clientWithSpy()

    await client.inputTextViaIme('a;b && c `d` $(e)')

    const encoded = shell.mock.calls[0]![1][5]!
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/)
  })
})

describe('AdbClient.listWebViewSockets', () => {
  it('解析 /proc/net/unix 并去掉 @ 前缀', async () => {
    const { client, shell } = clientWithSpy()
    shell.mockResolvedValue([
      'Num       RefCount Protocol Flags    Type St Inode Path',
      '0000000000000000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_12345',
      '0000000000000000: 00000002 00000000 00010000 0001 01 12346 @webview_devtools_remote_67890',
      '0000000000000000: 00000002 00000000 00010000 0001 01 12347 @android_webview_devtools_remote',
      '0000000000000000: 00000002 00000000 00010000 0001 01 12348 @something_else',
    ].join('\n'))

    await expect(client.listWebViewSockets()).resolves.toEqual([
      'webview_devtools_remote_12345',
      'webview_devtools_remote_67890',
    ])
  })

  it('无匹配时返回空数组', async () => {
    const { client, shell } = clientWithSpy()
    shell.mockResolvedValue('Num RefCount ... Path\n@other_socket\n')
    await expect(client.listWebViewSockets()).resolves.toEqual([])
  })
})
