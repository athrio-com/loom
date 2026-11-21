import { readFileSync } from 'fs'
import { join } from 'node:path'

export const textAt = (folder: string, name: string): string =>
  readFileSync(join(folder, name), 'utf8')

export const workingFolder = (): string => process.cwd()
