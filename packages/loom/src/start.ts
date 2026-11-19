import * as nodeModule from 'node:module'

nodeModule.enableCompileCache?.()

await import('./main')
