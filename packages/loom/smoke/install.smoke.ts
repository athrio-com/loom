import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = resolve(import.meta.dir, '..', '..', '..', 'scripts', 'install.sh')

const assetName = `loom-${process.platform}-${process.arch}.gz`

const standIn = Bun.gzipSync(new TextEncoder().encode('#!/bin/sh\necho "loom v9.9.9"\n'))

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

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

const install = async (sums: string | undefined) => {
  const server = releaseServer(sums)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'loom-install-')))
  const child = Bun.spawn(['sh', script], {
    env: {
      ...process.env,
      LOOM_DOWNLOAD: new URL('/download', server.url).href,
      LOOM_INSTALL_DIR: dir,
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
  return { status, stdout, stderr, dir }
}

describe.skipIf(process.platform === 'win32')('the install script', () => {
  it('installs an executable whose checksum matches the list', async () => {
    const { status, stdout, stderr, dir } = await install(`${sha256(standIn)}  ${assetName}\n`)
    expect({ status, stderr }).toMatchObject({ status: 0 })
    expect(stdout).toContain('Installed loom v9.9.9')
    expect(statSync(join(dir, 'loom')).mode & 0o111).not.toBe(0)
    expect(readdirSync(dir)).toEqual(['loom'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses an executable whose checksum does not match', async () => {
    const { status, stderr, dir } = await install(
      `${sha256(new Uint8Array())}  ${assetName}\n`,
    )
    expect({ status, stderr }).toMatchObject({ status: 1 })
    expect(stderr).toContain('does not match')
    expect(existsSync(join(dir, 'loom'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a release that carries no list of checksums', async () => {
    const { status, stderr, dir } = await install(undefined)
    expect({ status, stderr }).toMatchObject({ status: 1 })
    expect(stderr).toContain('SHA256SUMS')
    expect(existsSync(join(dir, 'loom'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
