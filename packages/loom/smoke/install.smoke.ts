import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const script = resolve(import.meta.dir, '..', '..', '..', 'scripts', 'install.sh')

const assetName = `loom-${process.platform}-${process.arch}.gz`

const standIn = Bun.gzipSync(new TextEncoder().encode('echo "loom v9.9.9"\n'))

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const listed = `${sha256(standIn)}  ${assetName}\n`

const releaseServer = (sums: string | undefined) =>
  Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname
      if (path === `/download/${assetName}`) return new Response(standIn)
      if (path === '/download/SHA256SUMS' && sums !== undefined) return new Response(sums)
      return new Response('not found', { status: 404 })
    },
  })

const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin'

const freshHome = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'loom-home-')))

const installed = (home: string): string => join(home, '.loom', 'bin')

const install = async (
  home: string,
  sums: string | undefined,
  options: { readonly args?: ReadonlyArray<string>; readonly env?: Record<string, string> } = {},
) => {
  const server = releaseServer(sums)
  const child = Bun.spawn(['/bin/sh', script, ...(options.args ?? [])], {
    env: {
      HOME: home,
      PATH: systemPath,
      SHELL: '/bin/zsh',
      LOOM_DOWNLOAD: new URL('/download', server.url).href,
      ...options.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  server.stop()
  return { status, stdout, stderr }
}

describe.skipIf(process.platform === 'win32')('the install script', () => {
  it('installs an executable whose checksum matches the list', async () => {
    const home = freshHome()
    const { status, stdout, stderr } = await install(home, listed)
    expect({ status, stderr }).toMatchObject({ status: 0 })
    expect(stdout).toContain('Installed loom v9.9.9')
    expect(statSync(join(installed(home), 'loom')).mode & 0o111).not.toBe(0)
    expect(readdirSync(installed(home))).toEqual(['loom'])
    rmSync(home, { recursive: true, force: true })
  })

  it('refuses an executable whose checksum does not match', async () => {
    const home = freshHome()
    const { status, stderr } = await install(home, `${sha256(new Uint8Array())}  ${assetName}\n`)
    expect({ status, stderr }).toMatchObject({ status: 1 })
    expect(stderr).toContain('does not match')
    expect(existsSync(join(installed(home), 'loom'))).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })

  it('refuses a release that carries no list of checksums', async () => {
    const home = freshHome()
    const { status, stderr } = await install(home, undefined)
    expect({ status, stderr }).toMatchObject({ status: 1 })
    expect(stderr).toContain('SHA256SUMS')
    expect(existsSync(join(installed(home), 'loom'))).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })
})

const pathLine = 'export PATH="$HOME/.loom/bin:$PATH"'

const occurrences = (text: string, line: string): number => text.split(line).length - 1

describe.skipIf(process.platform === 'win32')('the install script — PATH', () => {
  it('adds the folder to PATH in the profile once, however often it runs', async () => {
    const home = freshHome()
    const zshrc = join(home, '.zshrc')
    writeFileSync(zshrc, "alias ll='ls -l'\n")
    const first = await install(home, listed)
    const second = await install(home, listed)
    expect({ status: first.status, stderr: first.stderr }).toMatchObject({ status: 0 })
    expect({ status: second.status, stderr: second.stderr }).toMatchObject({ status: 0 })
    expect(first.stdout).toContain(`Added ${installed(home)} to PATH in ${zshrc}`)
    expect(second.stdout).toContain(`${zshrc} already adds ${installed(home)} to PATH`)
    const profile = readFileSync(zshrc, 'utf8')
    expect(profile).toStartWith("alias ll='ls -l'\n")
    expect(occurrences(profile, pathLine)).toBe(1)
    rmSync(home, { recursive: true, force: true })
  })

  it('changes no profile when the folder is already on PATH', async () => {
    const home = freshHome()
    const { status, stderr } = await install(home, listed, {
      env: { PATH: `${installed(home)}:${systemPath}` },
    })
    expect({ status, stderr }).toMatchObject({ status: 0 })
    expect(existsSync(join(home, '.zshrc'))).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })

  it('writes to the profile Bash reads on this system', async () => {
    const home = freshHome()
    const { status, stderr } = await install(home, listed, { env: { SHELL: '/bin/bash' } })
    expect({ status, stderr }).toMatchObject({ status: 0 })
    const profile = process.platform === 'darwin' ? '.bash_profile' : '.bashrc'
    expect(occurrences(readFileSync(join(home, profile), 'utf8'), pathLine)).toBe(1)
    rmSync(home, { recursive: true, force: true })
  })

  it('gives Fish a fish_add_path line in its own profile', async () => {
    const home = freshHome()
    const { status, stderr } = await install(home, listed, { env: { SHELL: '/usr/bin/fish' } })
    expect({ status, stderr }).toMatchObject({ status: 0 })
    expect(readFileSync(join(home, '.config', 'fish', 'config.fish'), 'utf8')).toContain(
      'fish_add_path "$HOME/.loom/bin"',
    )
    rmSync(home, { recursive: true, force: true })
  })

  it('leaves every profile alone with --no-modify-path or LOOM_NO_MODIFY_PATH', async () => {
    const flagged = freshHome()
    const unset = freshHome()
    const runs = [
      await install(flagged, listed, { args: ['--no-modify-path'] }),
      await install(unset, listed, { env: { LOOM_NO_MODIFY_PATH: '1' } }),
    ]
    runs.forEach(({ status, stdout, stderr }) => {
      expect({ status, stderr }).toMatchObject({ status: 0 })
      expect(stdout).toContain(pathLine)
    })
    expect(existsSync(join(flagged, '.zshrc'))).toBe(false)
    expect(existsSync(join(unset, '.zshrc'))).toBe(false)
    rmSync(flagged, { recursive: true, force: true })
    rmSync(unset, { recursive: true, force: true })
  })
})

const packageCopy = (copy: string): void => {
  mkdirSync(dirname(copy), { recursive: true })
  writeFileSync(copy, '#!/bin/sh\n', { mode: 0o755 })
}

describe.skipIf(process.platform === 'win32')('the install script — another loom', () => {
  it('names each older loom on PATH and the command that removes it', async () => {
    const home = freshHome()
    const npm = join(home, 'npm')
    const npmCopy = join(npm, 'lib/node_modules/@athrio/loom/dist/main.js')
    packageCopy(npmCopy)
    mkdirSync(join(npm, 'bin'))
    symlinkSync('../lib/node_modules/@athrio/loom/dist/main.js', join(npm, 'bin', 'loom'))
    const bun = join(home, '.bun')
    const bunCopy = join(bun, 'install/global/node_modules/@athrio/loom/dist/main.js')
    packageCopy(bunCopy)
    mkdirSync(join(bun, 'bin'))
    symlinkSync(bunCopy, join(bun, 'bin', 'loom'))
    const { status, stdout, stderr } = await install(home, listed, {
      env: { PATH: `${join(npm, 'bin')}:${join(bun, 'bin')}:${systemPath}` },
    })
    expect({ status, stderr }).toMatchObject({ status: 0 })
    expect(stdout).toContain(
      `Another loom is on your PATH, at ${join(npm, 'bin', 'loom')}, installed by npm. Remove it with:\n  npm uninstall -g @athrio/loom`,
    )
    expect(stdout).toContain(
      `Another loom is on your PATH, at ${join(bun, 'bin', 'loom')}, installed by Bun. Remove it with:\n  bun remove -g @athrio/loom`,
    )
    expect(existsSync(npmCopy)).toBe(true)
    expect(existsSync(bunCopy)).toBe(true)
    rmSync(home, { recursive: true, force: true })
  })
})

describe.skipIf(process.platform === 'win32')('the install script — a loom kept by hand', () => {
  it('refuses to replace a loom that is not a Loom executable', async () => {
    const home = freshHome()
    const own = join(installed(home), 'loom')
    const text = '#!/bin/sh\necho "loom v0.0.10"\n'
    mkdirSync(installed(home), { recursive: true })
    writeFileSync(own, text, { mode: 0o755 })
    const { status, stderr } = await install(home, listed)
    expect({ status, stderr }).toMatchObject({ status: 1 })
    expect(stderr).toContain(`${own} is not a Loom executable`)
    expect(readFileSync(own, 'utf8')).toBe(text)
    expect(readdirSync(installed(home))).toEqual(['loom'])
    rmSync(home, { recursive: true, force: true })
  })
})
